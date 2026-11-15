import test from 'node:test';
import assert from 'node:assert/strict';
import { commandLifecycle } from './lib/command-lifecycle.mjs';
import { hash, seal, unseal } from './lib/security.mjs';
import { verifiedRuntimeFailureReceipt } from './lib/command-runtime-recovery.mjs';

const plan = { operation: 'navigation_request', args: { destination: 'Laketown' } };
const config = { key: Buffer.alloc(32, 3), env: { TESLA_VEHICLE_VIN: 'SIMULATED' } };
function fixture() {
  let clock = Date.parse('2026-11-04T12:00:00Z'), owner = 0;
  const rows = new Map(), leases = new Map();
  const get = async key => { const v = rows.get(key); return v && v.expires > clock ? v.value : null; };
  const store = { get,
    put: async (key, value, ttl) => rows.set(key, { value, expires: clock + ttl*1000 }),
    once: async (key, ttl) => { if (await get(key)) return false; await store.put(key,'1',ttl); return true; },
    putOncePermanent: async (key,value) => { if (await get(key)) return false; rows.set(key,{value,expires:Infinity});return true; },
    persist: async key => { if (rows.has(key)) rows.get(key).expires=Infinity; },
    take: async key => { const value=await get(key); rows.delete(key);return value; },
    lock: async key => {
      if (leases.get(key)?.expires > clock) throw Error('busy');
      const token = ++owner; leases.set(key,{ token, expires: clock+60_000 });
      const owned=()=>{if(leases.get(key)?.token !== token || leases.get(key).expires <= clock)throw Error('busy');};
      return { saveWithGuard: async(value,pending,pendingValue)=>{
        owned();if(rows.get(pending)?.expires>clock)return false;
        rows.set(pending,{value:pendingValue,expires:Infinity});rows.set(key,{value,expires:Infinity});return true;
      }, clearGuard:async(pending,pendingValue)=>{
        if(leases.get(key)?.token===token&&leases.get(key).expires>clock&&rows.get(pending)?.value===pendingValue)rows.delete(pending);
      }, savePermanent: async value => {
        if (leases.get(key)?.token !== token || leases.get(key).expires <= clock) throw Error('busy');
        rows.set(key,{ value, expires: Infinity });
      }, release: async () => { if (leases.get(key)?.token === token) leases.delete(key); } };
    }
  };
  return { store, rows, make: () => commandLifecycle({ store, config, now: () => clock }),
    advance: ms => { clock += ms; }, receipt: async state => {
      const [key] = [...rows.keys()].filter(k=>k.startsWith('direct-state:'));
      const record = unseal(await get(key),config.key,key);
      await store.put('command-proxy-receipt:'+record.nonce,JSON.stringify({version:1,nonce:record.nonce,state,definitive_no_effect:state==='failed'}),86400);
    } };
}
const success = async before => { await before('a'.repeat(43)); return { accepted: true }; };
const verifiedFailure={state:'uncertain',operation:'navigation_request',request:'X-DUvqKOrThV05FFN0LqfuDfNnmOAYFgyGA8QgM7ZwQ',reason:'command_unavailable',nonce:'k'.repeat(43),created_at:'2026-11-04T21:30:56.519Z',updated_at:'2026-11-04T21:30:57.420Z'};
test('only the audited bootstrap failure becomes not-dispatched; guards and receipts remain',async()=>{
 const f=fixture();f.advance(11*3600000);
 const fingerprint=hash('owner\nSIMULATED\nnavigation_request\n'+JSON.stringify([['destination','Laketown']])),key='direct-state:'+fingerprint,pending='direct-pending:'+fingerprint;
 f.rows.set(key,{value:seal(verifiedFailure,config.key,key),expires:Infinity});f.rows.set(pending,{value:'lifecycle-v1:'+verifiedFailure.request,expires:Infinity});
 const status=await f.make().status('owner',plan);assert.equal(status.state,'failed');assert.equal(status.reason,'command_not_dispatched');assert.equal(status.proxy_accepted,false);assert.equal(status.retry_allowed,true);
 assert.equal(await f.store.get(pending),'lifecycle-v1:'+verifiedFailure.request);
 const evidence=await f.store.get('command-proxy-receipt:'+verifiedFailure.nonce);assert.equal(JSON.parse(evidence).source,'verified_vercel_bootstrap_failure');
 assert.equal((await f.make().execute('owner',plan,2,success)).accepted,true);
 assert.equal(await f.store.get('command-proxy-receipt:'+verifiedFailure.nonce),evidence);
});
test('runtime recovery rejects every different event and never overwrites an existing receipt',async()=>{
 for(const patch of [{request:'z'.repeat(43)},{reason:'command_outcome_unknown'},{operation:'door_lock'},{created_at:'2026-11-04T21:30:56.520Z'},{updated_at:'2026-11-04T21:30:57.421Z'}])assert.equal(verifiedRuntimeFailureReceipt({...verifiedFailure,...patch},Date.parse('2026-11-05')),null);
 const f=fixture();f.advance(11*3600000);const fingerprint=hash('owner\nSIMULATED\nnavigation_request\n'+JSON.stringify([['destination','Laketown']])),key='direct-state:'+fingerprint;
 f.rows.set(key,{value:seal(verifiedFailure,config.key,key),expires:Infinity});
 const existing=JSON.stringify({version:1,nonce:verifiedFailure.nonce,state:'uncertain'});
 await f.store.put('command-proxy-receipt:'+verifiedFailure.nonce,existing,86400);
 assert.equal((await f.make().status('owner',plan)).state,'uncertain');assert.equal(await f.store.get('command-proxy-receipt:'+verifiedFailure.nonce),existing);
});
test('same RPC number across supported command families never creates cross-command replay',async()=>{
 const f=fixture();let sent=0;
 for(const action of [plan,{operation:'door_lock',args:{}},{operation:'charge_port_door_open',args:{}},{operation:'set_temps',args:{driver_temp:22,passenger_temp:22}}]){
  const result=await f.make().execute('owner',action,1,async before=>{sent++;return success(before);});
  assert.equal(result.accepted,true);
  await f.make().execute('owner',action,1,async()=>assert.fail('identical transport replay dispatched'));
 }
 assert.equal(sent,4);
});
test('single success records acknowledgement and transport replay sends once',async()=>{
 const f=fixture();let sent=0;
 const dispatch=async before=>{sent++;return success(before);};
 const result=await f.make().execute('owner',plan,1,dispatch);
 assert.equal(result.accepted,true);assert.equal(result.completed,false);
 assert.equal(result.evidence.navigation_set,'unverified');assert.equal(result.evidence.iphone_app_sync,'not_verifiable');
 assert.deepEqual(await f.make().execute('owner',plan,1,dispatch),{...result,dispatch_performed:false,result_reused:true});assert.equal(sent,1);
 assert.equal((await f.make().status('owner',plan)).state,'acknowledged');
 assert.equal((await f.make().execute('owner',{...plan,args:{destination:'Elsewhere'}},1,dispatch)).accepted,true);assert.equal(sent,2);
});
test('definitive rejection permits only a new explicit request, not transport retry',async()=>{
 const f=fixture();let sent=0;
 const reject=async before=>{await before('b'.repeat(43));sent++;throw Object.assign(Error('command_rejected'),{definitiveNoEffect:true});};
 await assert.rejects(f.make().execute('owner',plan,1,reject),/command_rejected/);
 assert.equal((await f.make().status('owner',plan)).retry_allowed,true);
 await assert.rejects(f.make().execute('owner',plan,1,reject),/command_rejected/);assert.equal(sent,1);
 assert.equal((await f.make().execute('owner',plan,2,success)).accepted,true);
});
test('unknown response remains blocked across days and backend instances',async()=>{
 const f=fixture();let sent=0;
 await assert.rejects(f.make().execute('owner',plan,1,async before=>{await before('c'.repeat(43));sent++;throw Error('command_outcome_unknown');}),/command_outcome_unknown/);
 f.advance(3*86400000);
 assert.ok([...f.rows].some(([key,row])=>key.startsWith('direct-pending:')&&row.expires===Infinity));
 await assert.rejects(f.make().execute('owner',plan,2,async()=>assert.fail('duplicate')),e=>e.message==='command_pending'&&e.commandStatus.state==='uncertain');
 assert.equal(sent,1);assert.equal((await f.make().status('owner',plan)).retry_allowed,false);
});
test('legacy pending is retained as uncertain beyond its former expiry',async()=>{
 const f=fixture();const fingerprint=hash('owner\nSIMULATED\nnavigation_request\n'+JSON.stringify([['destination','Laketown']]));
 await f.store.put('direct-pending:'+fingerprint,'1',86400);
 const status=await f.make().status('owner',plan);assert.equal(status.reason,'legacy_pending_without_receipt');
 f.advance(2*86400000);
 await assert.rejects(f.make().execute('owner',plan,2,async()=>assert.fail('duplicate')),/command_pending/);
});
for(const state of ['acknowledged','failed'])test('reconciliation of a lost reply uses proxy receipt '+state+' without dispatch',async()=>{
 const f=fixture();let sent=0;
 await assert.rejects(f.make().execute('owner',plan,1,async before=>{await before('d'.repeat(43));sent++;throw Error('command_outcome_unknown');}));
 await f.receipt(state);
 const status=await f.make().status('owner',plan);assert.equal(status.state,state);assert.equal(sent,1);
 if(state==='acknowledged')assert.equal((await f.make().execute('owner',plan,1,async()=>assert.fail('duplicate'))).accepted,true);
 else assert.equal((await f.make().execute('owner',plan,2,success)).accepted,true);
});
test('concurrent requests never dispatch an identical action twice',async()=>{
 const f=fixture();let enter,finish,sent=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>finish=r);
 const first=f.make().execute('owner',plan,1,async before=>{await before('e'.repeat(43));sent++;enter();await gate;return{accepted:true};});
 await entered;
 await assert.rejects(f.make().execute('owner',plan,2,async()=>assert.fail('concurrent dispatch')),/command_pending/);
 assert.equal((await f.make().status('owner',plan)).state,'dispatched');
 finish();await first;assert.equal(sent,1);
});
test('expired created lease can be reconciled because old worker is fenced before send',async()=>{
 const f=fixture();let enter,finish,sent=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>finish=r);
 const first=f.make().execute('owner',plan,1,async before=>{enter();await gate;await before('f'.repeat(43));sent++;return{accepted:true};});
 await entered;f.advance(61_000);
 assert.equal((await f.make().status('owner',plan)).reason,'command_not_dispatched');
 finish();await assert.rejects(first,/busy/);assert.equal(sent,0);
 assert.equal((await f.make().status('owner',plan)).state,'failed');
});
test('accepted command with failed result storage stays guarded until internal reconciliation',async()=>{
 const f=fixture(),put=f.store.put;f.store.put=async(key,...args)=>{if(key.startsWith('direct-result:'))throw Error('store');return put(key,...args);};
 await assert.rejects(f.make().execute('owner',plan,1,success),/store/);
 f.store.put=put;
 await assert.rejects(f.make().execute('owner',plan,2,async()=>assert.fail('duplicate')),/command_pending/);
 assert.equal((await f.make().status('owner',plan)).state,'acknowledged');
 assert.equal((await f.make().execute('owner',plan,1,async()=>assert.fail('duplicate'))).accepted,true);
});
test('pre-dispatch failure is recorded as failed and needs a new explicit request',async()=>{
 const f=fixture();await assert.rejects(f.make().execute('owner',plan,1,async()=>{throw Error('budget');}),/budget/);
 assert.equal((await f.make().status('owner',plan)).state,'failed');
 assert.equal((await f.make().execute('owner',plan,2,success)).accepted,true);
});
test('orphaned dispatched state becomes uncertain at deadline without permitting redispatch',async()=>{
 const f=fixture();let enter,finish,sent=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>finish=r);
 const first=f.make().execute('owner',plan,1,async before=>{await before('g'.repeat(43));sent++;enter();await gate;return{accepted:true};});
 await entered;f.advance(61_000);
 const status=await f.make().status('owner',plan);assert.equal(status.state,'uncertain');assert.equal(status.retry_allowed,false);
 await assert.rejects(f.make().execute('owner',plan,2,async()=>assert.fail('duplicate')),/command_pending/);
 finish();await assert.rejects(first,/busy/);assert.equal(sent,1);
});
test('a completed transport identifier can be reused for a different action after a pre-dispatch failure',async()=>{
 const f=fixture();await assert.rejects(f.make().execute('owner',plan,1,async()=>{throw Error('budget');}));
 assert.equal((await f.make().execute('owner',{...plan,args:{destination:'Milano'}},1,success)).accepted,true);
});
test('a legacy guard racing preparation prevents dispatch and is retained without expiry',async()=>{
 const f=fixture();let sent=0;
 await assert.rejects(f.make().execute('owner',plan,1,async before=>{
  const stateKey=[...f.rows.keys()].find(k=>k.startsWith('direct-state:'));
  await f.store.put('direct-pending:'+stateKey.slice('direct-state:'.length),'1',86400);
  await before('h'.repeat(43));sent++;return{accepted:true};
 }),e=>e.message==='command_pending'&&e.commandStatus.reason==='legacy_pending_without_receipt');
 f.advance(2*86400000);
 await assert.rejects(f.make().execute('owner',plan,2,async()=>assert.fail('duplicate')),/command_pending/);
 assert.equal(sent,0);assert.ok([...f.rows].some(([k,v])=>k.startsWith('direct-pending:')&&v.expires===Infinity));
});

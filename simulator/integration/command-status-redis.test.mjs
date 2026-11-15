import test from 'node:test';
import assert from 'node:assert/strict';
import { localRedis } from '../test-support/redis-rest.mjs';
import { statusFixture } from '../test-support/mcp-status-fixture.mjs';
import { hash, seal } from '../lib/security.mjs';
import { commandLifecycle } from '../lib/command-lifecycle.mjs';
import { createTeslaBackend } from '../lib/tesla.mjs';
import { TESLA_P256_ORIGIN } from '../lib/partner-p256-identity.mjs';

const prefix='tesla-voice:v1:';
const original={operation:'navigation_request',arguments:{destination:'Northville, Lombardia'}};
test('audited pre-handler failure appends a receipt through real Redis without deleting its guard',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db),args={destination:'Central Square, Piazza del Duomo, Milano, Italia'},c=identity(f,args);
 const record={state:'uncertain',operation:'navigation_request',request:'X-DUvqKOrThV05FFN0LqfuDfNnmOAYFgyGA8QgM7ZwQ',reason:'command_unavailable',nonce:'r'.repeat(43),created_at:'2026-11-04T21:30:56.519Z',updated_at:'2026-11-04T21:30:57.420Z'};
 await db.command('SET',prefix+c.key,seal(record,f.config.key,c.key));
 const guard='lifecycle-v1:'+record.request;await db.command('SET',prefix+c.pending,guard);
 const result=(await f.rpc({operation:'navigation_request',arguments:args})).result;
 assert.equal(result.state,'failed');assert.equal(result.reason,'command_not_dispatched');assert.equal(result.proxy_accepted,false);assert.equal(result.retry_allowed,true);
 assert.equal(await db.command('GET',prefix+c.pending),guard);
 const receipt=JSON.parse(await db.command('GET',prefix+'command-proxy-receipt:'+record.nonce));
 assert.equal(receipt.evidence.proxy_request_id,'mjm8f-1793827857210-1666bce97069');assert.equal(receipt.definitive_no_effect,true);
 assert.equal(f.teslaCalls(),0);
});
test('authenticated MCP continuation uses real Redis and distinguishes repeated identical spoken-intent fixtures',async t=>{
 const db=await localRedis();t.after(()=>db.close());let sent=0,uncertain=false;
 const f=statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config:{...config,origin:TESLA_P256_ORIGIN,
  env:{...config.env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_DAILY_READ_LIMIT:'50'}},store,fetcher:async(url,options)=>{
   assert.ok(!Object.hasOwn(JSON.parse(options.body).arguments,'_tesla_invocation_token'));
   assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');sent++;
   return uncertain?Response.json({error:'command_outcome_unknown'},{status:502}):Response.json({accepted:true});
  }})});
 const key='tokens:'+hash(f.config.issuer+'\nowner');
 await f.store.put(key,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_cmds','vehicle_device_data','vehicle_charging_cmds']},f.config.key,key),86400);
 await f.backend.prepareVehicleCommandSetup('owner');
 const invoke=args=>f.rpc(args,{name:'execute_requested_vehicle_command'});
 for(const [operation,args] of [['navigation_request',{destination:'Central Square'}],['charge_port_door_open',{}],['set_temps',{driver_temp:22,passenger_temp:22}]]){
  for(let fresh=0;fresh<2;fresh++){
   const before=sent,ready=(await invoke({operation,arguments:args})).result;
   assert.equal(ready.status,'invocation_ready');assert.equal(sent,before);
   const call=ready.continuation;assert.deepEqual(Object.keys(call).sort(),['arguments','operation']);
   assert.equal((await invoke(call)).result.dispatch_performed,true);assert.equal(sent,before+1);
   assert.equal((await invoke(call)).result.result_reused,true);assert.equal(sent,before+1);
  }
 }
 uncertain=true;const action={operation:'navigation_request',arguments:{destination:'Different fixture'}};
 const ready=(await invoke(action)).result,call=ready.continuation;
 assert.equal((await invoke(call)).result.error.code,'command_outcome_unknown');const after=sent;
 const replacement=(await invoke(action)).result;
 assert.equal((await invoke(replacement.continuation)).result.error.code,'command_pending');assert.equal(sent,after);
 assert.ok(db.calls.some(c=>c[0]==='EVAL'&&c[1].includes('command_guard_claim')));
});
test('real Redis preserves duplicate guards across command families sharing an RPC ID',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db),lifecycle=commandLifecycle({store:f.store,config:f.config});let sent=0;
 for(const action of [{operation:'navigation_request',args:{destination:'Central Square'}},{operation:'charge_port_door_open',args:{}},{operation:'set_temps',args:{driver_temp:22,passenger_temp:22}}]){
  const result=await lifecycle.execute('owner',action,1,async before=>{await before('z'.repeat(43));sent++;return{accepted:true};});
  assert.equal(result.dispatch_performed,true);
  const replay=await lifecycle.execute('owner',action,1,async()=>assert.fail('duplicate dispatch'));
  assert.equal(replay.result_reused,true);assert.equal(replay.dispatch_performed,false);
 }
 assert.equal(sent,3);assert.equal(f.teslaCalls(),0);
});
function identity(f,args=original.arguments,requestId=47) {
 const fingerprint=hash('owner\n'+f.env.TESLA_VEHICLE_VIN+'\nnavigation_request\n'+JSON.stringify(Object.entries(args).sort(([a],[b])=>a.localeCompare(b))));
 const request=hash('owner\n'+(typeof requestId==='number'?'n:'+JSON.stringify(requestId):'s:'+requestId));
 return {fingerprint,request,key:'direct-state:'+fingerprint,pending:'direct-pending:'+fingerprint};
}
async function seed(db,f,{args,requestId=47,nonce='a'.repeat(43)}={}) {
 const c=identity(f,args,requestId),record={state:'uncertain',operation:'navigation_request',request:c.request,nonce,deadline:0,created_at:'2026-11-04T20:00:00Z',updated_at:'2026-11-04T20:00:00Z'};
 await db.command('SET',prefix+c.key,seal(record,f.config.key,c.key));
 await db.command('SET',prefix+c.pending,'lifecycle-v1:'+c.request);
 return c;
}
test('authenticated MCP command status uses actual Redis operations and Lua without Tesla',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db);
 for(const legacy of [true,false]) {
  const count=db.calls.length;
  for(const args of [{},{destination:{name:'Northville'}},{destination:'Northville',extra:true}]) {
   const result=await f.rpc({operation:'navigation_request',arguments:args},{legacy});
   assert.equal(result.body.result.isError,true);assert.equal(result.result.error.code,'invalid_arguments');
   assert.equal(result.result.diagnostic.stage,'status_selector_validation');
  }
  assert.equal(db.calls.length,count,'invalid execution-shaped input must fail before Redis');
 }
 const c=await seed(db,f);
 const wrong=await f.rpc({operation:'navigation_request',arguments:{destination:'NORTHVILLE CON MINOPRIO'}});
 assert.equal(wrong.result.state,'not_found');assert.equal(wrong.result.retry_allowed,false);
 assert.equal(wrong.result.backend_received,null);assert.equal(wrong.result.lookup.no_match_proves_no_dispatch,false);
 assert.equal(await db.command('GET',prefix+c.pending),'lifecycle-v1:'+c.request);
 const exact=await f.rpc(original);assert.equal(exact.result.state,'uncertain');assert.ok(exact.result.status_reference);
 const byRequest=await f.rpc({operation:'navigation_request',request_id:47});
 assert.equal(byRequest.result.state,'uncertain');assert.equal(byRequest.result.lookup.mode,'original_request_id');
 const byReference=await f.rpc({status_reference:byRequest.result.status_reference});
 assert.equal(byReference.result.state,'uncertain');assert.equal(byReference.result.lookup.mode,'status_reference');
 const receiptKey=prefix+'command-proxy-receipt:'+'a'.repeat(43);
 const receipt=JSON.stringify({version:1,nonce:'a'.repeat(43),state:'acknowledged',definitive_no_effect:false});
 await db.command('SET',receiptKey,receipt);
 const ack=await f.rpc({status_reference:byReference.result.status_reference});
 assert.equal(ack.result.state,'acknowledged');assert.equal(ack.result.completed,false);
 assert.equal(await db.command('GET',receiptKey),receipt);
 assert.equal(await db.command('GET',prefix+c.pending),'lifecycle-v1:'+c.request,'status must never delete command guards');
 assert.equal(await db.command('EXISTS',prefix+c.key),1);
 assert.ok(db.calls.some(c=>c[0]==='EVAL'&&c[1].includes("'SCAN'")),'real bounded SCAN/GET Lua must execute');
 assert.ok(db.calls.some(c=>c[0]==='EVAL'&&c[1].includes("'SET'")),'real fenced journal writes must execute');
 assert.ok(!db.calls.some(c=>c[0]==='EVAL'&&c[1].includes('command_guard_clear')),'no guard-clear Lua on status');
 assert.equal(f.teslaCalls(),0);
});
test('legacy Northville pending stays distinct across literal destination variants',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db),c=identity(f);
 await db.command('SET',prefix+c.pending,'1','EX',86400);
 const missing=await f.rpc({operation:'navigation_request',arguments:{destination:'Northville'}});
 assert.equal(missing.result.state,'not_found');assert.equal(missing.result.retry_allowed,false);
 const legacy=await f.rpc(original);assert.equal(legacy.result.state,'uncertain');assert.equal(legacy.result.reason,'legacy_pending_without_receipt');
 assert.equal(await db.command('GET',prefix+c.pending),'1');assert.equal(await db.command('TTL',prefix+c.pending),-1);
 assert.ok(db.calls.some(c=>c[0]==='PERSIST'));
 assert.equal((await f.rpc({status_reference:legacy.result.status_reference})).result.state,'uncertain');
 assert.equal((await f.rpc({request_id:47})).result.state,'not_found','legacy guard without a request binding cannot be invented');
 assert.equal(f.teslaCalls(),0);
});
test('reused request IDs are ambiguous; references are account/vehicle bound; errors remain safe',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db);
 await seed(db,f);await seed(db,f,{args:{destination:'Laketown'},nonce:'b'.repeat(43)});
 assert.equal((await f.rpc({request_id:47})).result.state,'ambiguous_command');
 const cached=identity(f,original.arguments,81);
 await db.command('SET',prefix+'direct-result:'+cached.request,JSON.stringify({fingerprint:cached.fingerprint,result:{accepted:true,operation:'door_lock'}}));
 assert.equal((await f.rpc({operation:'navigation_request',request_id:81})).result.error.code,'invalid_arguments','a result for another operation is not a navigation acknowledgement');
 const r=(await f.rpc(original)).result;
 const foreign=statusFixture(db);foreign.config.issuer='https://different-issuer.invalid/';
 await assert.rejects(foreign.backend.vehicleCommandStatus('owner',undefined,undefined,{statusReference:r.status_reference}),/invalid_arguments/);
 const count=db.calls.length;
 const denied=await f.rpc(original,{scope:'battery:read'});assert.equal(denied.result.error.required_scope,'vehicle:control');assert.equal(db.calls.length,count);
 const corrupt=identity(f);await db.command('SET',prefix+corrupt.key,'corrupt-journal');
 const error=(await f.rpc(original)).result;assert.equal(error.error.code,'store');assert.equal(error.diagnostic.stage,'status_journal_decode');
 assert.doesNotMatch(JSON.stringify(error),/corrupt-journal|BEGIN|fixture-store/);assert.equal(f.teslaCalls(),0);
});
test('bounded scan and Redis transport failures cannot become no-dispatch evidence or Tesla OAuth errors',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db);
 await db.command('MSET',...Array.from({length:1000},(_,i)=>['fixture-unrelated:'+i,'1']).flat());
 const partial=(await f.rpc({request_id:'not-found'})).result;
 assert.equal(partial.state,'lookup_incomplete');assert.equal(partial.lookup.complete,false);assert.equal(partial.retry_allowed,false);
 for(const status of [401,503]) {
  const broken=statusFixture({...db,fetcher:async()=>Response.json({error:'PRIVATE_PROVIDER_BODY'},{status})});
  const error=(await broken.rpc(original)).result;
  assert.equal(error.error.code,'store');assert.equal(error.diagnostic.stage,'status_state_lookup');
  assert.doesNotMatch(JSON.stringify(error),/PRIVATE_PROVIDER_BODY|reauthorize/);assert.equal(broken.teslaCalls(),0);
 }
});

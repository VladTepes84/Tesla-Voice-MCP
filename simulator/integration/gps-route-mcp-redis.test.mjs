import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import {localRedis} from '../test-support/redis-rest.mjs';
import {statusFixture} from '../test-support/mcp-status-fixture.mjs';
import {createTeslaBackend} from '../lib/tesla.mjs';
import {hash,seal,unseal} from '../lib/security.mjs';
import {TESLA_P256_ORIGIN} from '../lib/partner-p256-identity.mjs';
const exec=promisify(execFile), operation='navigation_gps_request';
const args={points:[{lat:45,lon:9},{lat:46,lon:10},{lat:45,lon:9}]};

test('authenticated MCP coordinate fixture reuses real lifecycle, budget and Go coordinator with local Redis',async t=>{
 const db=await localRedis();t.after(()=>db.close());
 const dir=await mkdtemp(join(tmpdir(),'tesla-gps-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=join(dir,'gps-fixture.test');
 const goEnv={...process.env,GOCACHE:process.env.GOCACHE||'/tmp/tesla-go-cache',GOMODCACHE:process.env.GOMODCACHE||'/tmp/tesla-go-mod',GOPATH:process.env.GOPATH||'/tmp/tesla-go-path'};
 await exec(process.env.TESLA_TEST_GO_BIN||'go',['test','-c','-o',binary,'./api'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:goEnv,timeout:60000});
 let proxies=0,ordinary=0,failSecond=false;const receipts=[];
 const make=({enabled=true,inject=true}={})=>statusFixture(db,{createTeslaBackend:({config,store})=>{
  const c={...config,origin:TESLA_P256_ORIGIN,env:{...config.env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_DAILY_READ_LIMIT:'50',TESLA_GPS_ROUTE_FIXTURE_ENABLED:String(enabled)}};
  return createTeslaBackend({config:c,store,fetcher:async()=>{ordinary++;return Response.json({accepted:true});},...(inject?{gpsRouteProxyFixture:async(url,options)=>{
   assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');
   const body=JSON.parse(options.body);assert.equal(body.operation,operation);assert.ok(body.route_deadline_unix_ms>Date.now()&&body.route_deadline_unix_ms<=Date.now()+24000);assert.equal(options.signal.aborted,false);assert.deepEqual(Object.keys(body.arguments),['points']);
   const signingKey=createHmac('sha256',c.key).update('tesla-command-proxy-v1').digest();
   assert.equal(options.headers['x-tesla-command-signature'],createHmac('sha256',signingKey).update(options.headers['x-tesla-command-time']+'\n'+options.body).digest('base64url'));
   proxies++;
   // Pass the EXACT authenticated envelope via stdin, using ONLY generated
   // fixture key/token. No secrets in argv/env/logs; Go bridge rejects real IDs.
   assert.equal(body.access_token,'fixture-access');assert.match(body.navigation_guard_owner,/^[A-Za-z0-9_-]{43}$/);
   const child=exec(binary,['-test.run=^TestGPSHandlerMCPFixtureBridge$','-test.v'],{env:{...goEnv,TESLA_GPS_HANDLER_FIXTURE:'true'},timeout:Math.max(1,body.route_deadline_unix_ms-Date.now()+500)});
   child.child.stdin.end(JSON.stringify({Body:options.body,Stamp:options.headers['x-tesla-command-time'],Signature:options.headers['x-tesla-command-signature'],FailSecond:failSecond,RedisSocket:db.socket}));
   const {stdout}=await child;
   const row=stdout.split('\n').find(l=>l.startsWith('GPS_ROUTE_FIXTURE_RESULT='));assert.ok(row,'Go bridge did not execute');
   const result=JSON.parse(row.slice('GPS_ROUTE_FIXTURE_RESULT='.length));receipts.push(result);
   return Response.json(result.Response,{status:result.HTTPCode});
  }}:{})});
 }});
 const call=(f,a,options={})=>f.rpc(a,{name:'execute_requested_vehicle_command',...options});
 const initial=db.calls.length;
 for(const options of [{enabled:false},{inject:false}])assert.equal((await call(make(options),{operation,arguments:args})).result.error.code,'command_transport_unsupported');
 assert.equal(db.calls.length,initial);assert.equal(proxies,0);
 const f=make();const key='tokens:'+hash(f.config.issuer+'\nowner');
 await f.store.put(key,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_cmds']},f.config.key,key),86400);
 await f.backend.prepareVehicleCommandSetup('owner');
 const denied=await call(f,{operation,arguments:args},{scope:'battery:read'});assert.equal(denied.body.result.isError,true);assert.equal(proxies,0);
 assert.equal((await call(f,{operation,arguments:{points:[{lat:91,lon:0},{lat:0,lon:0}]}})).result.error.code,'invalid_arguments');
 const ready=(await call(f,{operation,arguments:args})).result;assert.equal(ready.status,'invocation_ready');assert.equal(proxies,0);
 const accepted=(await call(f,ready.continuation)).result;assert.equal(accepted.accepted,true);assert.equal(accepted.completed,false);assert.equal(proxies,1);
 assert.equal(receipts[0].Sent,3);assert.equal(receipts[0].Summary.VehicleRouteVerified,false);assert.equal(receipts[0].Summary.AllAPIAccepted,true);
 assert.equal((await call(f,ready.continuation)).result.result_reused,true);assert.equal(proxies,1);
 // Full route reserves three units in the shared Production usage ledger.
 assert.equal(db.calls.filter(c=>c[0]==='EVAL'&&String(c[1]).includes('local used=')&&c.at(-2)===3).length,1);
 failSecond=true;const other={points:[{lat:45,lon:9},{lat:46,lon:10},{lat:47,lon:11}]};
 const next=(await call(f,{operation,arguments:other})).result;
 assert.equal((await call(f,next.continuation)).result.error.code,'command_outcome_unknown');assert.equal(proxies,2);
 assert.equal(receipts[1].Sent,2);assert.equal(receipts[1].Summary.AcceptedSteps,1);assert.equal(receipts[1].Summary.Partial,true);assert.equal(receipts[1].Summary.Blocked,true);
 const again=(await call(f,{operation,arguments:other})).result;
 assert.equal((await call(f,again.continuation)).result.error.code,'command_pending');assert.equal(proxies,2);
 assert.equal((await f.rpc({operation,arguments:other})).result.state,'uncertain');
 // Different explicit actions proceed while the original uncertain action stays retained.
 const pendingScope=hash('owner\n'+f.env.TESLA_VEHICLE_VIN+'\n'+operation+'\n'+JSON.stringify(Object.entries(other).sort(([a],[b])=>a.localeCompare(b))));
 const pendingKey='tesla-voice:v1:gps-fixture-navigation:'+hash(f.env.TESLA_VEHICLE_VIN)+':'+pendingScope+':pending';
 failSecond=false;
 const different={points:[{lat:45,lon:9},{lat:48,lon:12}]};
 const differentReady=(await call(f,{operation,arguments:different})).result;assert.equal(differentReady.status,'invocation_ready');
 assert.equal((await call(f,differentReady.continuation)).result.accepted,true);assert.equal(proxies,3);
 const singleReady=(await call(f,{operation:'navigation_request',arguments:{destination:'Fixture destination only'}})).result;
 assert.equal(singleReady.status,'invocation_ready');
 assert.equal((await call(f,singleReady.continuation)).result.accepted,true);assert.equal(ordinary,1);
 assert.equal(await db.command('TTL',pendingKey),-1);
 // The permanent guard remains enforced with fixture gate/callback disabled.
 const off=make({enabled:false,inject:false});
 const afterDisable=(await off.rpc({operation,arguments:other})).result;
 assert.equal(afterDisable.state,'uncertain');assert.equal(afterDisable.navigation_fence.blocked,true);
 assert.equal(afterDisable.navigation_fence.releasable_on_new_explicit_action,false);
 const single=(await call(off,{operation:'navigation_request',arguments:{destination:'Fixture disabled test'}})).result;
 assert.equal(single.status,'invocation_ready');
 assert.equal((await call(off,single.continuation)).result.accepted,true);assert.equal(proxies,3);assert.equal(ordinary,2);
 const canonical=JSON.stringify(Object.entries(other).sort(([a],[b])=>a.localeCompare(b)));
 const stateKey='direct-state:'+hash('owner\n'+f.env.TESLA_VEHICLE_VIN+'\n'+operation+'\n'+canonical);
 const original=await f.store.get(stateKey),record=unseal(original,f.config.key,stateKey);
 // A successful older request with identical route arguments is NOT evidence
 // for the action whose guard is pending. Do not reconcile solely by destination.
 const previous={...record,request:hash('different earlier action'),state:'acknowledged',result_saved:true,result:{accepted:true}};
 await db.command('SET','tesla-voice:v1:'+stateKey,seal(previous,f.config.key,stateKey));
 const mismatch=(await off.rpc({operation,arguments:other})).result;
 assert.equal(mismatch.navigation_fence.state,'receipt_mismatch');assert.equal(mismatch.navigation_fence.releasable_on_new_explicit_action,false);
 assert.equal((await call(off,single.continuation)).result.result_reused,true);assert.equal(ordinary,2);
 await db.command('SET','tesla-voice:v1:'+stateKey,original);
 // A nonce mismatch in the proxy receipt cannot acknowledge/release the route.
 const receiptKey='command-proxy-receipt:'+record.nonce;
 await f.store.put(receiptKey,JSON.stringify({version:1,nonce:'wrong',state:'acknowledged'}),3600);
 assert.equal((await off.rpc({operation,arguments:other})).result.state,'uncertain');
 assert.equal(await db.command('TTL',pendingKey),-1);
 // Simulate a definitive proxy acknowledgement tied to the ORIGINAL nonce.
 // This is a fixture receipt, not Tesla evidence. Status reconciles without send
 // and does NOT itself delete the vehicle guard.
 await f.store.put(receiptKey,JSON.stringify({version:1,nonce:record.nonce,state:'acknowledged'}),3600);
 const reconciled=(await off.rpc({operation,arguments:other})).result;
 assert.equal(reconciled.state,'acknowledged');assert.equal(reconciled.navigation_fence.blocked,true);
 assert.equal(reconciled.navigation_fence.releasable_on_new_explicit_action,true);
 assert.equal(await db.command('TTL',pendingKey),-1);assert.equal(proxies,3);
 const reused=(await call(f,next.continuation)).result;
 assert.equal(reused.result_reused,true);assert.equal(reused.dispatch_performed,false);assert.equal(proxies,3);
 assert.equal(await db.command('GET',pendingKey),null);
 assert.ok(await f.store.get(stateKey),'lifecycle journal was deleted');
 assert.ok(await f.store.get(receiptKey),'proxy receipt was deleted');
 const day=new Date().toISOString().slice(0,10);
 // The fixture reserves three points, three partial-route points, two alternate GPS points,
 // and two explicit single destinations across these synthetic dispatches.
 assert.equal(await f.store.get('read-budget-extra:'+day),'10');



 // The fixture feature is never advertised as a real supported transport.
 const catalog=await f.rpc({}, {name:'get_vehicle_command_catalog',scope:'battery:read'});
 assert.equal(catalog.result.operations.find(o=>o.operation===operation).transport_supported,false);
});

test('real candidate activation uses existing MCP tool and fetch path, remains production-only and rejects partial success',async t=>{
 const {GPS_ROUTE_ORDER_SCHEMA}=await import('../lib/gps-route-activation.mjs');
 const db=await localRedis();t.after(()=>db.close());
 const overrides={APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_REAL_RELEASE_APPROVED:'true',TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'true',TESLA_GPS_ROUTE_ORDER_SCHEMA:GPS_ROUTE_ORDER_SCHEMA,TESLA_DAILY_READ_LIMIT:'50'};
 const call=(f,a)=>f.rpc(a,{name:'execute_requested_vehicle_command'});
 let proxyCalls=0;
 for(const change of [{TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'false'},{TESLA_GPS_ROUTE_ORDER_SCHEMA:'guessed'},{VERCEL_ENV:'preview'},{TESLA_REAL_RELEASE_APPROVED:'false'}]){
  const off=statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,fetcher:()=>{proxyCalls++;throw Error('activation bypass');}})},{...overrides,...change});
  const before=db.calls.length;assert.equal((await call(off,{operation,arguments:args})).result.error.code,'command_transport_unsupported');assert.equal(db.calls.length,before);assert.equal(proxyCalls,0);
 }
 const dir=await mkdtemp(join(tmpdir(),'tesla-real-gps-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const binary=join(dir,'handler.test');
 const goEnv={...process.env,GOCACHE:process.env.GOCACHE||'/tmp/tesla-go-cache',GOMODCACHE:process.env.GOMODCACHE||'/tmp/tesla-go-mod',GOPATH:process.env.GOPATH||'/tmp/tesla-go-path'};
 await exec(process.env.TESLA_TEST_GO_BIN||'go',['test','-c','-o',binary,'./api'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:goEnv,timeout:60000});
 let incomplete=false;
 const f=statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,fetcher:async(url,options)=>{
  assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');const body=JSON.parse(options.body);assert.equal(body.access_token,'fixture-access');proxyCalls++;
  if(incomplete)return Response.json({accepted:true,completed:false,navigation_mode:'experimental_gps_append',route_summary:{TotalSteps:2,AcceptedSteps:1,AllAPIAccepted:false,Partial:true,Blocked:true,VehicleRouteVerified:false}});
  const child=exec(binary,['-test.run=^TestGPSHandlerMCPFixtureBridge$','-test.v'],{env:{...goEnv,TESLA_GPS_HANDLER_FIXTURE:'true'},timeout:Math.max(1,body.route_deadline_unix_ms-Date.now()+500)});
  child.child.stdin.end(JSON.stringify({Body:options.body,Stamp:options.headers['x-tesla-command-time'],Signature:options.headers['x-tesla-command-signature'],FailSecond:false,RedisSocket:db.socket,OrderSchema:GPS_ROUTE_ORDER_SCHEMA}));
  const {stdout}=await child;const row=stdout.split('\n').find(l=>l.startsWith('GPS_ROUTE_FIXTURE_RESULT='));assert.ok(row);const result=JSON.parse(row.slice('GPS_ROUTE_FIXTURE_RESULT='.length));assert.equal(result.Sent,3);
  return Response.json(result.Response,{status:result.HTTPCode});
 }})},overrides);
 const key='tokens:'+hash(f.config.issuer+'\nowner');await f.store.put(key,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_cmds']},f.config.key,key),86400);await f.backend.prepareVehicleCommandSetup('owner');
 const catalog=(await f.rpc({}, {name:'get_vehicle_command_catalog',scope:'battery:read'})).result.operations.find(o=>o.operation===operation);
 assert.equal(catalog.transport_supported,true);assert.equal(catalog.implementation_status,'experimental_transport');assert.equal(catalog.vehicle_test_status,'not_tested');assert.deepEqual(catalog.allowed_arguments,['points']);assert.equal(catalog.atomic,false);
 const ready=(await call(f,{operation,arguments:args})).result;assert.equal(ready.status,'invocation_ready');assert.equal(proxyCalls,0);
 const accepted=(await call(f,ready.continuation)).result;assert.equal(accepted.accepted,true);assert.equal(accepted.completed,false);assert.equal(accepted.coordinate_route.accepted_stops,3);assert.equal(accepted.coordinate_route.vehicle_route_verified,false);assert.equal(proxyCalls,1);
 assert.equal((await call(f,ready.continuation)).result.result_reused,true);assert.equal(proxyCalls,1);
 incomplete=true;const next=(await call(f,{operation,arguments:{points:[{lat:45,lon:9},{lat:48,lon:12}]}})).result;
 const partial=(await call(f,next.continuation)).result;assert.equal(partial.error.code,'command_outcome_unknown');assert.equal(proxyCalls,2);
 const retry=(await call(f,{operation,arguments:{points:[{lat:45,lon:9},{lat:48,lon:12}]}})).result;
 assert.equal((await call(f,retry.continuation)).result.error.code,'command_pending');assert.equal(proxyCalls,2);
});

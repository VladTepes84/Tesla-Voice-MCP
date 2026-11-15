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
import {NATIVE_COORDINATE_SCHEMA,NATIVE_SC_SCHEMA} from '../lib/native-navigation-candidates.mjs';
const exec=promisify(execFile);
const overrides={APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_REAL_RELEASE_APPROVED:'true',TESLA_LOCATION_ENABLED:'true',TESLA_DAILY_READ_LIMIT:'50',
 TESLA_NATIVE_COORDINATE_ENABLED:'true',TESLA_NATIVE_COORDINATE_PILOT_ENABLED:'true',TESLA_NATIVE_COORDINATE_SCHEMA:NATIVE_COORDINATE_SCHEMA,TESLA_NATIVE_SUPERCHARGER_ENABLED:'true',TESLA_NATIVE_SUPERCHARGER_SCHEMA:NATIVE_SC_SCHEMA};
async function keys(f){
 const key='tokens:'+hash(f.config.issuer+'\nowner');
 await f.store.put(key,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_cmds','vehicle_location','vehicle_device_data']},f.config.key,key),86400);
 await f.backend.prepareVehicleCommandSetup('owner');
}
for(const sc of [false,true])test(`authenticated native ${sc?'Supercharger ID':'whole coordinate list'} uses signed Go handler, actual Redis receipts and no replay`,async t=>{
 const db=await localRedis();t.after(()=>db.close());
 const dir=await mkdtemp(join(tmpdir(),'tesla-native-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const binary=join(dir,'handler.test');
 const goEnv={...process.env,GOCACHE:process.env.GOCACHE||'/tmp/tesla-go-cache',GOMODCACHE:process.env.GOMODCACHE||'/tmp/tesla-go-mod',GOPATH:process.env.GOPATH||'/tmp/tesla-go-path'};
 await exec(process.env.TESLA_TEST_GO_BIN||'go',['test','-c','-o',binary,'./api'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:goEnv,timeout:60000});
 let proxies=0,ordinary=0,reads=0,lost=false;const receipts=[];
 const make=patch=>statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,fetcher:async(url,options)=>{
  if(new URL(url).pathname.endsWith('/nearby_charging_sites')){reads++;return Response.json({response:{superchargers:[{id:'9223372036854775807',name:'Synthetic chosen SC',location:{lat:45, long:9}}]}});}
  const body=JSON.parse(options.body);
  if(body.operation==='navigation_request'){ordinary++;return Response.json({accepted:true});}
  assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');proxies++;
  assert.equal(body.access_token,'fixture-access');assert.ok(body.route_deadline_unix_ms>Date.now());assert.ok(options.signal);assert.equal(options.signal.aborted,false);
  const signingKey=createHmac('sha256',config.key).update('tesla-command-proxy-v1').digest();
  assert.equal(options.headers['x-tesla-command-signature'],createHmac('sha256',signingKey).update(options.headers['x-tesla-command-time']+'\n'+options.body).digest('base64url'));
  const child=exec(binary,['-test.run=^TestNativeHandlerMCPFixtureBridge$','-test.v'],{env:{...goEnv,TESLA_NATIVE_HANDLER_FIXTURE:'true'},timeout:Math.max(1,body.route_deadline_unix_ms-Date.now()+500)});
  child.child.stdin.end(JSON.stringify({Body:options.body,Stamp:options.headers['x-tesla-command-time'],Signature:options.headers['x-tesla-command-signature'],RedisSocket:db.socket,Lost:lost}));
  const {stdout}=await child;const line=stdout.split('\n').find(x=>x.startsWith('NATIVE_FIXTURE_RESULT='));assert.ok(line);
  const result=JSON.parse(line.slice('NATIVE_FIXTURE_RESULT='.length));assert.equal(result.Sent,1);receipts.push(await store.get('command-proxy-receipt:'+body.nonce));
  return Response.json(result.Response,{status:result.HTTPCode});
 }})},{...overrides,...patch});
 const f=make(),operation=sc?'navigation_sc_request':'navigation_waypoints_request',args=sc?{site_id:'9223372036854775807'}:{waypoints:'45,9;46,10;45,9'};
 const call=(g,a)=>g.rpc(a,{name:'execute_requested_vehicle_command'});
 for(const patch of [{TESLA_NATIVE_COORDINATE_ENABLED:'false',TESLA_NATIVE_SUPERCHARGER_ENABLED:'false'},{TESLA_NATIVE_COORDINATE_SCHEMA:'unknown',TESLA_NATIVE_SUPERCHARGER_SCHEMA:'unknown'},{VERCEL_ENV:'preview'},{TESLA_REAL_RELEASE_APPROVED:'false'}]){
  const denied=await call(make(patch),{operation,arguments:args});
  if(denied.body.error)assert.equal(denied.body.error.code,-32602);else assert.equal(denied.result.error.code,'command_transport_unsupported');
 }
 assert.equal(proxies,0);assert.equal(reads,0);
 await keys(f);
 if(sc){
  assert.equal((await call(f,{operation,arguments:args})).result.error.code,'native_station_selection_required');assert.equal(reads,0);
  const nearby=(await f.rpc({}, {name:'get_nearby_charging_sites',scope:'location:read'})).result;assert.equal(nearby.native_selection_cache.ready,true);assert.equal(reads,1);
  assert.equal((await call(f,{operation,arguments:{site_id:'123'}})).result.error.code,'native_station_selection_required');
 }
 const catalog=(await f.rpc({}, {name:'get_vehicle_command_catalog',scope:'battery:read'})).result.operations.find(o=>o.operation===operation);
 assert.equal(catalog.transport_supported,true);assert.equal(catalog.implementation_status,'experimental_transport');assert.equal(catalog.vehicle_test_status,'not_tested');
 const ready=(await call(f,{operation,arguments:args})).result;assert.equal(ready.status,'invocation_ready');assert.equal(proxies,0);
 const accepted=(await call(f,ready.continuation)).result;
 assert.equal(accepted.accepted,true);assert.equal(accepted.completed,false);assert.equal(accepted.api_actuation_count,1);assert.equal(accepted.requested_destinations,sc?1:3);assert.equal(accepted.vehicle_route_verified,false);assert.equal(accepted.battery_preconditioning_verified,false);assert.equal(proxies,1);
 assert.equal(JSON.parse(receipts[0]).state,'acknowledged');
 if(sc){const k='native-sc-selection:'+hash(f.config.issuer+'\nowner\n'+f.env.TESLA_VEHICLE_VIN);const record=unseal(await f.store.get(k),f.config.key,k);await f.store.put(k,seal({...record,expires:1},f.config.key,k),900);}
 assert.equal((await call(f,ready.continuation)).result.result_reused,true);assert.equal(proxies,1);
 if(sc)await f.rpc({}, {name:'get_nearby_charging_sites',scope:'location:read'});
 lost=true;const next=(await call(f,{operation,arguments:args})).result;
 const uncertain=(await call(f,next.continuation)).result;assert.equal(uncertain.error.code,'command_outcome_unknown');assert.equal(proxies,2);assert.equal(JSON.parse(receipts[1]).state,'uncertain');
 const off=make({TESLA_NATIVE_COORDINATE_ENABLED:'false',TESLA_NATIVE_SUPERCHARGER_ENABLED:'false'});
 const status=(await off.rpc({operation,arguments:args})).result;assert.equal(status.retry_allowed,false);assert.equal(status.navigation_fence.blocked,true);
 const single=(await call(off,{operation:'navigation_request',arguments:{destination:'Synthetic subsequent navigation'}})).result;
 assert.equal(single.status,'invocation_ready');
 assert.equal((await call(off,single.continuation)).result.accepted,true);assert.equal(proxies,2);assert.equal(ordinary,1);
 assert.equal((await call(off,single.continuation)).result.result_reused,true);assert.equal(ordinary,1);
 assert.ok(db.calls.some(c=>c[0]==='EVAL'));
});

test('native accepted=true with contradictory metadata stays uncertain, with no fallback or retry',async t=>{
 const db=await localRedis();t.after(()=>db.close());let proxies=0;
 const f=statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,fetcher:async()=>{proxies++;return Response.json({accepted:true,completed:false,navigation_mode:'experimental_native_coordinate_batch',api_actuation_count:2,requested_destinations:2,vehicle_route_verified:true});}})},overrides);
 await keys(f);const call=a=>f.rpc(a,{name:'execute_requested_vehicle_command'});
 const ready=(await call({operation:'navigation_waypoints_request',arguments:{waypoints:'45,9;46,10'}})).result;
 assert.equal((await call(ready.continuation)).result.error.code,'command_outcome_unknown');assert.equal(proxies,1);
 assert.equal((await call(ready.continuation)).result.error.code,'command_pending');assert.equal(proxies,1);
});

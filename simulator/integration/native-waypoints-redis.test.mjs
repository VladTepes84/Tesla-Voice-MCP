import test from 'node:test';import assert from 'node:assert/strict';
import {localRedis} from '../test-support/redis-rest.mjs';import {statusFixture} from '../test-support/mcp-status-fixture.mjs';
import {createTeslaBackend} from '../lib/tesla.mjs';import {realMcp} from '../lib/real-mcp.mjs';import {hash,seal} from '../lib/security.mjs';import {TESLA_P256_ORIGIN} from '../lib/partner-p256-identity.mjs';
const operation='navigation_waypoints_request',args={waypoints:'refId:FIXTURE_AAAA,refId:FIXTURE_BBBB,refId:FIXTURE_CCCC'};
const verifiedWaypointPlaceIds=['FIXTURE_AAAA','FIXTURE_BBBB','FIXTURE_CCCC','FIXTURE_DDDD'];
test('native gate preserves existing Redis deduplication and status after disabling',async t=>{
 const db=await localRedis();t.after(()=>db.close());let sent=0,uncertain=false;
 const gates={APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',TESLA_DAILY_READ_LIMIT:'50'};
 const make=enabled=>statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,verifiedWaypointPlaceIds,fetcher:async(url,options)=>{
  assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');const body=JSON.parse(options.body);assert.equal(body.operation,operation);assert.equal(Object.keys(body.arguments).length,1);assert.ok(body.route_deadline_unix_ms>0);assert.match(body.navigation_guard_owner,/^[A-Za-z0-9_-]{43}$/);sent++;
  return uncertain?Response.json({error:'command_outcome_unknown'},{status:502}):Response.json({accepted:true,completed:false,navigation_mode:'experimental_native_refid_waypoints',vehicle_route_verified:false,api_actuation_count:1,requested_destinations:1});
 }}),realMcp:({config,backend})=>realMcp({config,backend})},{...gates,TESLA_NATIVE_WAYPOINTS_ENABLED:String(enabled)});
 const off=make(false),before=db.calls.length;
 assert.equal((await off.rpc({operation,arguments:args},{name:'execute_requested_vehicle_command'})).result.error.code,'command_transport_unsupported');assert.equal(sent,0);assert.equal(db.calls.length,before);
 const f=make(true),key='tokens:'+hash(f.config.issuer+'\nowner');
 await f.store.put(key,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_cmds','vehicle_device_data','vehicle_charging_cmds']},f.config.key,key),86400);await f.backend.prepareVehicleCommandSetup('owner');
 const invoke=a=>f.rpc(a,{name:'execute_requested_vehicle_command'});
 const ready=(await invoke({operation,arguments:args})).result;assert.equal(ready.status,'invocation_ready');assert.equal(sent,0);
 const accepted=(await invoke(ready.continuation)).result;assert.equal(accepted.accepted,true);assert.equal(accepted.completed,false);assert.equal(sent,1);
 assert.equal((await invoke(ready.continuation)).result.result_reused,true);assert.equal(sent,1);
 uncertain=true;const different={waypoints:'refId:FIXTURE_AAAA,refId:FIXTURE_BBBB,refId:FIXTURE_DDDD'};
 const next=(await invoke({operation,arguments:different})).result;assert.equal((await invoke(next.continuation)).result.error.code,'command_outcome_unknown');assert.equal(sent,2);
 const blocked=(await invoke({operation,arguments:different})).result;assert.equal((await invoke(blocked.continuation)).result.error.code,'command_pending');assert.equal(sent,2);
 const status=(await make(false).rpc({operation,arguments:different})).result;assert.equal(status.state,'uncertain');assert.equal(status.retry_allowed,false);assert.equal(sent,2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createHmac} from 'node:crypto';
import {localRedis} from '../test-support/redis-rest.mjs';
import {statusFixture} from '../test-support/mcp-status-fixture.mjs';
import {createTeslaBackend} from '../lib/tesla.mjs';
import {gpsNavigationFenceStatus,withGPSFixtureNavigationFence} from '../lib/gps-route-fixture-fence.mjs';
import {hash,seal} from '../lib/security.mjs';
import {TESLA_P256_ORIGIN} from '../lib/partner-p256-identity.mjs';

const exec=promisify(execFile);
const replacePoint={lat:45.5499106,lon:9.0782851};
const appendPoint={lat:45.4641669,lon:9.1916121};

test('MCP GPS diagnostic keeps Replace and Append separate, owner-bound and single-use over Redis',async t=>{
 const db=await localRedis();t.after(()=>db.close());
 const dir=await mkdtemp(join(tmpdir(),'tesla-gps-diagnostic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=join(dir,'gps-diagnostic-fixture.test');
 const goEnv={...process.env,GOCACHE:process.env.GOCACHE||'/tmp/tesla-go-cache',GOMODCACHE:process.env.GOMODCACHE||'/tmp/tesla-go-mod',GOPATH:process.env.GOPATH||'/tmp/tesla-go-path'};
 await exec(process.env.TESLA_TEST_GO_BIN||'go',['test','-c','-o',binary,'./api'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:goEnv,timeout:60000});
 let proxies=0,dropNextReply=false;const fixtures=[];
 const f=statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,
  fetcher:()=>{throw Error('Unexpected real HTTP/Tesla call');},gpsRouteProxyFixture:async(url,options)=>{
   assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');
   const body=JSON.parse(options.body);assert.equal(body.operation,'navigation_gps_request');assert.equal(body.access_token,'fixture-access');
   assert.deepEqual(Object.keys(body.arguments),['points']);assert.equal(body.arguments.points.length,1);
   assert.ok(body.gps_diagnostic);assert.ok(body.navigation_guard_owner);assert.ok(body.route_deadline_unix_ms>Date.now());
   const signingKey=createHmac('sha256',config.key).update('tesla-command-proxy-v1').digest();
   assert.equal(options.headers['x-tesla-command-signature'],createHmac('sha256',signingKey).update(options.headers['x-tesla-command-time']+'\n'+options.body).digest('base64url'));
   proxies++;
   const child=exec(binary,['-test.run=^TestGPSDiagnosticHandlerMCPFixtureBridge$','-test.v'],{env:{...goEnv,TESLA_GPS_DIAGNOSTIC_HANDLER_FIXTURE:'true'},timeout:Math.max(1,body.route_deadline_unix_ms-Date.now()+500)});
   child.child.stdin.end(JSON.stringify({Body:options.body,Stamp:options.headers['x-tesla-command-time'],Signature:options.headers['x-tesla-command-signature'],RedisSocket:db.socket}));
   const {stdout}=await child;const row=stdout.split('\n').find(line=>line.startsWith('GPS_DIAGNOSTIC_FIXTURE_RESULT='));assert.ok(row,'Go diagnostic bridge did not execute');
   const fixture=JSON.parse(row.slice('GPS_DIAGNOSTIC_FIXTURE_RESULT='.length));fixtures.push(fixture);
   if(dropNextReply){dropNextReply=false;throw Error('fetch failed');}
   return Response.json(fixture.Response,{status:fixture.HTTPCode});
  }})},{
  APP_ORIGIN:TESLA_P256_ORIGIN,
  VERCEL_ENV:'production',
  TESLA_DAILY_READ_LIMIT:'50',
  TESLA_GPS_ROUTE_FIXTURE_ENABLED:'true'
 });
 const tokenKey='tokens:'+hash(f.config.issuer+'\nowner');
 await f.store.put(tokenKey,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_cmds']},f.config.key,tokenKey),86400);
 await f.backend.prepareVehicleCommandSetup('owner');
 const listing=(await f.rpc({}, {name:'get_vehicle_command_catalog',scope:'battery:read'}));assert.ok(listing.result);
 const call=(name,args)=>f.rpc(args,{name,scope:'vehicle:control'});
 const unprivileged=await f.rpc({replace_point:replacePoint,append_point:appendPoint},{name:'start_gps_navigation_diagnostic',scope:'battery:read'});
 assert.equal(unprivileged.result.error.code,'mcp_authorization_required');assert.equal(proxies,0,'diagnostic MCP tools require vehicle:control');
 const unchecked=await call('append_gps_navigation_diagnostic',{session_id:'0123456789abcdef0123456789abcdef',append_point:appendPoint,display_checked:false});
 assert.equal(unchecked.body.error.code,-32602);assert.equal(proxies,0,'Append requires the explicit display_checked assertion');
 const start=await call('start_gps_navigation_diagnostic',{replace_point:replacePoint,append_point:appendPoint});
 assert.equal(start.response.status,200);assert.equal(start.result.accepted,true);assert.equal(start.result.phase,'replace');assert.equal(start.result.accepted_stops,1);assert.equal(start.result.total_stops,2);assert.equal(start.result.vehicle_route_verified,false);assert.equal(start.result.display_verified,false);assert.equal(proxies,1);
 assert.equal(fixtures[0].Sent,1,'Replace call must send one action only');assert.equal(fixtures[0].Payloads.length,1);
 const sessionID=start.result.session_id;assert.match(sessionID,/^[a-f0-9]{32}$/);
 const pendingKey='tesla-voice:v1:gps-fixture-navigation:'+hash(f.env.TESLA_VEHICLE_VIN)+':pending';
 assert.ok(await db.command('GET',pendingKey),'Replace must retain the diagnostic navigation guard');
 const duplicateReplace=await call('start_gps_navigation_diagnostic',{replace_point:replacePoint,append_point:appendPoint});
 assert.equal(duplicateReplace.result.result_reused,true);assert.equal(duplicateReplace.result.session_id,sessionID);assert.equal(proxies,1);
 const beforeAppend=await call('append_gps_navigation_diagnostic',{session_id:'ffffffffffffffffffffffffffffffff',append_point:appendPoint,display_checked:true});
 assert.equal(beforeAppend.result.error.code,'command_pending');assert.equal(proxies,1);
 await assert.rejects(()=>f.backend.executeGPSNavigationDiagnosticAppend('other-account',{session_id:sessionID,append_point:appendPoint,display_checked:true},'foreign'),/command_pending/);
 const append=await call('append_gps_navigation_diagnostic',{session_id:sessionID,append_point:appendPoint,display_checked:true});
 assert.equal(append.response.status,200);assert.equal(append.result.accepted,true);assert.equal(append.result.phase,'append');assert.equal(append.result.accepted_stops,2);assert.equal(append.result.vehicle_route_verified,false);assert.equal(append.result.display_verified,false);assert.equal(proxies,2);
 assert.equal(fixtures[1].Sent,1,'Append call must send one action only');assert.equal(fixtures[1].Payloads.length,1);
 assert.equal(fixtures[0].Response.phase,'replace');assert.equal(fixtures[1].Response.phase,'append');
 assert.equal(await db.command('GET',pendingKey),null,'finished diagnostic must release the navigation guard');
 const duplicateAppend=await call('append_gps_navigation_diagnostic',{session_id:sessionID,append_point:appendPoint,display_checked:true});
 assert.equal(duplicateAppend.result.result_reused,true);assert.equal(proxies,2,'repeated Append must not dispatch again');
 const diagnosticVehicleScope=createHash('sha256').update('gps-diagnostic-vehicle-v1\n'+f.env.TESLA_VEHICLE_VIN).digest('hex');
 const diagnosticGuard=`tesla-voice:gps-diagnostic:v1:{${diagnosticVehicleScope}}:guard`;
 assert.equal(await db.command('GET',diagnosticGuard),null,'completed diagnostic guard must be released');

 // A second session simulates the proxy/vehicle accepting Append while the
 // application loses its response. Repeating the MCP call must not dispatch.
 const nextReplacePoint={lat:45.551,lon:9.081},nextAppendPoint={lat:45.466,lon:9.194};
 const nextStart=await call('start_gps_navigation_diagnostic',{replace_point:nextReplacePoint,append_point:nextAppendPoint});
 assert.equal(nextStart.result.phase,'replace');assert.equal(proxies,3);
 dropNextReply=true;
 const uncertain=await call('append_gps_navigation_diagnostic',{session_id:nextStart.result.session_id,append_point:nextAppendPoint,display_checked:true});
 assert.equal(uncertain.result.error.code,'command_outcome_unknown');assert.equal(proxies,4);assert.equal(fixtures[3].Sent,1);
 const afterTimeout=await call('append_gps_navigation_diagnostic',{session_id:nextStart.result.session_id,append_point:nextAppendPoint,display_checked:true});
 assert.equal(afterTimeout.result.result_reused,true,'the matching durable proxy receipt may be reconciled without another dispatch');
 assert.equal(afterTimeout.result.accepted,true);assert.equal(afterTimeout.result.phase,'append');
 assert.equal(afterTimeout.result.vehicle_route_verified,false);assert.equal(proxies,4,'an uncertain Append must never be dispatched again');
 assert.equal(fixtures[3].Sent,1,'the proxy receipt belongs to the single Append action');
});


test('an acknowledged Replace permits a new explicit single destination without replaying diagnostic',async t=>{
 const db=await localRedis();t.after(()=>db.close());
 const f=statusFixture(db,{createTeslaBackend:({config,store})=>createTeslaBackend({config,store,fetcher:()=>{throw Error('No Tesla calls allowed');}})},{VERCEL_ENV:'production'});
 const subject='owner';
 const key='gps-fixture-navigation:'+hash(f.env.TESLA_VEHICLE_VIN);
 const owner='fixture-owner';
 const session='0123456789abcdef0123456789abcdef';
 const scope='a'.repeat(64);
 const plan={group:'navigation',operation:'navigation_request',args:{destination:'Central Square'}};
 const fingerprint=hash(subject+'\n'+f.env.TESLA_VEHICLE_VIN+'\n'+plan.operation+'\n'+JSON.stringify(Object.entries(plan.args).sort(([a],[b])=>a.localeCompare(b))));
 const record={kind:'gps_diagnostic',owner,subject_hash:hash(subject),session_id:session,account_scope:scope,state:'replace_accepted',phase:'replace',expires_at:new Date(Date.now()+900000).toISOString(),expires_at_ms:Date.now()+900000,operation:plan.operation,fingerprint,request:hash(subject+'\ns:diagnostic-fixture')};
 await f.store.put(key,seal(record,f.config.key,key),900);
 await f.store.put(key+':pending',owner,900);
 const before=await gpsNavigationFenceStatus({store:f.store,config:f.config,subject,plan});
 assert.equal(before.blocked,true);
 assert.equal(before.releasable_on_new_explicit_action,true);
 let dispatches=0;
 const result=await withGPSFixtureNavigationFence({store:f.store,config:f.config,subject,plan,
  requestId:'fresh-explicit-navigation',enabled:false,
  run:async()=>{dispatches++;return {accepted:true};}});
 assert.equal(result.accepted,true);
 assert.equal(dispatches,1);
 assert.equal(await f.store.get(key+':pending'),null);
 const journal=await f.store.get(key);
 assert.ok(journal,'diagnostic receipt must be preserved');
});

import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign} from 'node:crypto';
import {realMcp} from './lib/real-mcp.mjs';import {request} from './offline-request.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'offline-planner',use:'sig',alg:'RS256'};
const config={origin:'https://example.invalid',issuer:'https://issuer.invalid/',audience:'https://example.invalid/mcp',jwks:{keys:[jwk]},env:{MCP_ALLOWED_SUBJECT:'fixture',TESLA_READ_ENABLED:'true',TESLA_LOCATION_ENABLED:'true'}};
function token(scope){const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:config.issuer,aud:config.audience,sub:'fixture',iat:now-10,exp:now+600,scope})).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');}
const input={origin:{lat:45.4642,lon:9.19},destination:{lat:46.4285,lon:9.7636},roundTrip:true,batteryPercent:39,batterySource:'simulated',usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,externalMapsConsent:true};
const backend=new Proxy({preferences:{get:async()=>({preferences:null})}},{get(target,key){if(key in target)return target[key];assert.fail('Tesla backend accessed');}});
const call=(scope,method,params)=>request(method,params,{authorization:'Bearer '+token(scope)});
test('saved charging-map consent is revocable and never reads Tesla',async t=>{
 let consent=false,networkCalls=0;
 const handler=realMcp({config,backend:{preferences:{get:async()=>({preferences:{chargingMapsConsent:consent}})},tripPlans:{getDraft:async()=>({available:true,route_input:{navigationOnly:true}})},
  location:()=>assert.fail('GPS read'),battery:()=>assert.fail('battery read')}});
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
 globalThis.fetch=async url=>{networkCalls++;assert.doesNotMatch(String(url),/tesla\.com|fleet-api/);
  if(String(url).includes('/api/interpreter'))return Response.json({elements:[{type:'node',id:10,lat:45.44,lon:10.99,tags:{'socket:type2':'2'}}]});
  if(String(url).includes('/route/'))return Response.json({code:'Ok',routes:[{distance:20000,duration:1200,legs:[{distance:20000,duration:1200}]}]});
  return new Response(null,{status:503});};
 const invoke=async()=>{const body=await(await handler(call('location:read','tools/call',{name:'find_charging_sites',arguments:{center:{lat:45.44,lon:10.99},radiusKm:5,connectorType:'AC'}}))).json();return JSON.parse(body.result.content[0].text);};
 const before=await invoke();assert.equal(before.error.code,'map_consent_required');assert.equal(networkCalls,0);
 consent=true;const result=await invoke();assert.equal(result.sites[0].source,'OPENSTREETMAP');assert.equal(result.vehicle_read_performed,false);
 const navigation=await(await handler(call('battery:read location:read','tools/call',{name:'plan_smart_trip',arguments:{origin:'Milano',destination:'Laketown',navigationOnly:true}}))).json();
 assert.equal(JSON.parse(navigation.result.content[0].text).error.code,'map_consent_required');
 const continuation=await(await handler(call('battery:read location:read','tools/call',{name:'plan_smart_trip',arguments:{continuationId:'x'.repeat(43)}}))).json();
 assert.ok(JSON.parse(continuation.result.content[0].text).error);
 const trip=await(await handler(call('battery:read location:read','tools/call',{name:'plan_charging_road_trip',arguments:{origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:false,batteryPercent:90,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:4}}))).json();
 assert.equal(JSON.parse(trip.result.content[0].text).sent_to_vehicle,false);
 const count=networkCalls;consent=false;const revoked=await invoke();assert.equal(revoked.error.code,'map_consent_required');assert.equal(networkCalls,count);
});
test('command continuation crosses the existing argument schema without forwarding internal metadata to Tesla',async()=>{
 let calls=0;
 const run=realMcp({config:{...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}},backend:{
  executeRequestedCommand:async(subject,operation,args,id,invocation)=>{
   calls++;assert.equal(operation,'navigation_request');assert.deepEqual(args,{destination:'Central Square'});
   assert.equal(invocation.token,'a'.repeat(43));return{fixture:true};
  }
 }});
 const invoke=async args=>{const body=await(await run(call('vehicle:control','tools/call',{name:'execute_requested_vehicle_command',arguments:args}))).json();return JSON.parse(body.result.content[0].text);};
 const args={operation:'navigation_request',arguments:{destination:'Central Square',_tesla_invocation_token:'a'.repeat(43)}};
 assert.equal((await invoke({...args,invocation_token:'b'.repeat(43)})).error.code,'invalid_command_invocation');assert.equal(calls,0);
 assert.equal((await invoke(args)).fixture,true);assert.equal(calls,1);
 assert.equal((await invoke({...args,invocation_token:'a'.repeat(43)})).fixture,true);assert.equal(calls,2);
});
test('existing protected MCP discovers and invokes the national planner with scoped fixture credentials, never Tesla',async()=>{
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async url=>{
  calls++;assert.ok(!/tesla\.com|auth\.tesla|fleet-api/.test(url));
  if(url.includes('cruscotto-italia.dati.gov.it'))return Response.json({_source:'GSE - Piattaforma Unica Nazionale (PUN)',_source_url:'https://www.piattaformaunicanazionale.it/idr',_license:'CC BY 4.0',_generated_at:new Date().toISOString(),_snapshot_date:new Date().toISOString().slice(0,10),punti:[{id_evse:'IT*A0C*E12006005400005*1A',lat:45.850473,lon:9.39382,cpo:'A2A E.MOBILITY S.R.L.',stato:'Attivo',publication_status:'PUBLISHED',standard_connettore:'IEC_62196_T2_COMBO',corrente:'DC',potenza_w:50000}]});
  if(url.includes('/table/'))return Response.json({code:'Ok',distances:[[0,160863.2,54805.4],[166314.6,0,107000],[55000,106507.4,0]]});
  if(url.includes('/route/')){const legs=url.includes('9.39382,45.850473')?[54805.4,106507.4,166314.6]:[160863.2,166314.6];return Response.json({code:'Ok',routes:[{distance:legs.reduce((a,b)=>a+b),duration:7200,legs:legs.map(distance=>({distance,duration:2400})),geometry:{coordinates:[[9.19,45.4642],[9.39382,45.850473],[9.7636,46.4285],[9.19,45.4642]]}}]});}
  return new Response(null,{status:503});
 };
 try{
  const handler=realMcp({config,backend}),scope='battery:read location:read';
  const listed=await (await handler(call(scope,'tools/list'))).json();
  assert.ok(listed.result.tools.some(t=>t.name==='plan_charging_road_trip'));
  const r=await (await handler(call(scope,'tools/call',{name:'plan_charging_road_trip',arguments:input}))).json();
  const plan=JSON.parse(r.result.content[0].text);
  assert.equal(plan.charging_plan.feasible,true);assert.equal(plan.sent_to_vehicle,false);
  assert.equal(plan.charging_plan.stops[0].source,'IT_AGID_GSE_PUN');assert.ok(plan.charging_plan.legs.every(l=>l.reserve_met));assert.ok(calls>0);
 }finally{globalThis.fetch=old;}
});
test('planner rejects missing location scope before catalog, routing or vehicle access',async()=>{
 const old=globalThis.fetch;globalThis.fetch=()=>assert.fail('network before scope');
 try{const body=await (await realMcp({config,backend})(call('battery:read','tools/call',{name:'plan_charging_road_trip',arguments:input}))).json();
 assert.equal(body.result.isError,true);assert.equal(JSON.parse(body.result.content[0].text).error.required_scope,'location:read');
 }finally{globalThis.fetch=old;}
});

test('stored itinerary and command reconciliation use existing scopes without Tesla calls',async()=>{
 const calls=[];
 const handler=realMcp({config:{...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}},backend:{
  tripPlans:{get:async(subject,id)=>{calls.push(['trip',subject,id]);return{available:true,requires_explicit_request_per_destination:true};}},
  vehicleCommandStatus:async(subject,operation,args)=>{calls.push(['status',subject,operation,args]);return{state:'uncertain',retry_allowed:false};},
  battery:()=>assert.fail('Tesla called'),location:()=>assert.fail('GPS called'),executeRequestedCommand:()=>assert.fail('command sent')
 }});
 const invoke=async(scope,name,arguments_)=>{
  const body=await(await handler(call(scope,'tools/call',{name,arguments:arguments_}))).json();
  return JSON.parse(body.result.content[0].text);
 };
 const id='t'.repeat(43),args={operation:'navigation_request',arguments:{destination:'Laketown'}};
 for(const scope of ['battery:read','location:read'])assert.equal((await invoke(scope,'get_planned_trip',{id})).error.required_scope,'battery:read location:read');
 assert.equal((await invoke('battery:read','get_vehicle_command_status',args)).error.required_scope,'vehicle:control');
 assert.equal(calls.length,0);
 assert.equal((await invoke('battery:read location:read','get_planned_trip',{id})).available,true);
 assert.equal((await invoke('vehicle:control','get_vehicle_command_status',args)).retry_allowed,false);
 assert.equal(calls.length,2);
 const list=await(await handler(call('vehicle:control','tools/list'))).json();
 assert.deepEqual(list.result.tools.find(t=>t.name==='get_vehicle_command_status').securitySchemes[0].scopes,['vehicle:control']);
});

test('protected MCP registers smart trip and persists owner preferences across handler instances', async t => {
 const records = new Map();
 const store = {
  get: async key => records.get(key),
  lock: async key => ({ savePermanent: async value => { records.set(key, value); }, release: async () => {} })
 };
 const { chargingPreferences } = await import('./lib/charging-preferences.mjs');
 const make=()=>realMcp({config,backend:{
  preferences:chargingPreferences({config:{...config,key:Buffer.alloc(32,9)},store,now:Date.now}),
  battery:()=>assert.fail('Tesla called'),location:()=>assert.fail('GPS called')
 }});
 const invoke=async(handler,scope,name,args={})=>{
  const r=await (await handler(call(scope,'tools/call',{name,arguments:args}))).json();
  return r.result ? JSON.parse(r.result.content[0].text) : r.error;
 };
 const both='battery:read location:read';
 const handler=make();
 const listed=await (await handler(call(both,'tools/list'))).json();
 const smart=listed.result.tools.find(t=>t.name==='plan_smart_trip');
 assert.deepEqual(smart.securitySchemes[0].scopes,['battery:read','location:read']);
 assert.ok(listed.result.tools.some(t=>t.name==='get_charging_preferences'));
 assert.equal((await invoke(handler,'battery:read','get_charging_preferences')).initialized,false);
 assert.equal((await invoke(handler,'location:read','set_charging_preferences',{reservePercent:20})).error.required_scope,'battery:read');
 assert.equal((await invoke(handler,'battery:read','set_charging_preferences',{reservePercent:20})).initialized,true);
 assert.equal((await invoke(make(),'battery:read','get_charging_preferences')).preferences.reservePercent,20);
 assert.equal((await invoke(make(),'battery:read','set_charging_preferences',{chargingMapsConsent:true})).preferences.chargingMapsConsent,true);
 assert.equal((await invoke(make(),'battery:read','set_charging_preferences',{chargingMapsConsent:false})).preferences.chargingMapsConsent,false);
 const args={origin:input.origin,destination:input.destination,batteryPercent:90,simulatedBattery:true,externalMapsConsent:true};
 assert.equal((await invoke(handler,'location:read','plan_smart_trip',args)).error.required_scope,both);
 assert.equal((await invoke(handler,'battery:read','plan_smart_trip',args)).error.required_scope,both);
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
 globalThis.fetch=async url=>{
  assert.equal(new URL(url).hostname,'router.project-osrm.org');
  return Response.json({code:'Ok',routes:[{distance:20000,duration:1200,legs:[{distance:20000,duration:1200}]}]});
 };
 const result=await invoke(make(),both,'plan_smart_trip',args);
 assert.equal(result.status,'simulated_plan');
 assert.equal(result.charging_recommendation.required,false);
 assert.equal(result.charging_recommendation.reserve_percent,20);
 assert.equal(result.charging_recommendation.status,'no_charging_needed');
 assert.equal(result.navigation.energy_verified,true);
 assert.equal('personal_tariffs_available' in result.preferences,false);
 assert.equal(result.sent_to_vehicle,false);

});


 test('authenticated MCP rejects a smart-trip reserve below 15 before any vehicle call',async()=>{
  const handler=realMcp({config,backend:new Proxy({}, {get:()=>assert.fail('backend accessed before validation')})});
  const response=await (await handler(call('battery:read location:read','tools/call',{name:'plan_smart_trip',arguments:{origin:input.origin,destination:input.destination,batteryPercent:39,reservePercent:14,externalMapsConsent:true}}))).json();
  assert.equal(response.error.code,-32602);
 });

test('authenticated legacy-schema find_charging_sites uses national DC and returns correlatable backend evidence',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
 globalThis.fetch=async url=>{
  assert.doesNotMatch(url,/tesla\.com|fleet-api/);
  if(!url.includes('cruscotto-italia.dati.gov.it'))return new Response(null,{status:503});
  return Response.json({_source:'GSE PUN',_source_url:'https://www.piattaformaunicanazionale.it/idr',_license:'CC BY 4.0',_generated_at:new Date().toISOString(),_snapshot_date:new Date().toISOString().slice(0,10),punti:[{id_evse:'IT*TEST*COLICO',lat:46.14,lon:9.38,cpo:'Fixture',stato:'Attivo',publication_status:'PUBLISHED',standard_connettore:'IEC_62196_T2_COMBO',corrente:'DC',potenza_w:50000}]});
 };
 const handler=realMcp({config,backend});
 const response=await(await handler(call('location:read','tools/call',{name:'find_charging_sites',arguments:{center:{lat:46.135,lon:9.37},radiusKm:12,externalMapsConsent:true}}))).json();
 const result=JSON.parse(response.result.content[0].text);
 assert.equal(response.result.isError,false);assert.equal(result.connector_type,'CCS2');assert.equal(result.search_status,'partial_results');assert.equal(result.sites[0].source,'IT_AGID_GSE_PUN');
 assert.equal(result.execution_evidence.backend,'TESLA_MCP');assert.equal(result.execution_evidence.tool,'find_charging_sites');assert.ok(result.execution_evidence.execution_reference);assert.equal(result.vehicle_read_performed,false);
});

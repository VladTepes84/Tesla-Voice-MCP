import test from 'node:test';
import assert from 'node:assert/strict';
import {localRedis} from '../test-support/redis-rest.mjs';
import {statusFixture} from '../test-support/mcp-status-fixture.mjs';
import {realMcp} from '../lib/real-mcp.mjs';
test('authenticated road planner ignores saved AC enablement, retains preferences and prepares one DC handoff with real Redis',async t=>{
 const db=await localRedis();t.after(()=>db.close());
 const make=()=>statusFixture(db,{realMcp:({config,backend})=>realMcp({config:{...config,env:{...config.env,TESLA_LOCATION_ENABLED:'true'}},backend})});
 const f=make(),scope='battery:read location:read';
 const preferences={usableCapacityKwh:68,consumptionKwhPer100Km:13,efficiencyPercent:90,reservePercent:15,chargingTargetPercent:85,allowAcCharging:true,vehicleAcPowerKw:11,maximumAcStopMinutes:180};
 assert.equal((await f.rpc(preferences,{scope,name:'set_charging_preferences'})).result.initialized,true);
 const another=make();
 assert.deepEqual((await another.rpc({},{scope,name:'get_charging_preferences'})).result.preferences,preferences);
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async url=>{
  assert.doesNotMatch(url,/tesla\.com|fleet-api|redis/);
  if(url.includes('cruscotto-italia.dati.gov.it'))return Response.json({_source:'GSE PUN',_source_url:'https://www.piattaformaunicanazionale.it/idr',_license:'CC BY 4.0',_snapshot_date:new Date().toISOString().slice(0,10),_generated_at:new Date().toISOString(),punti:[
   {id_evse:'IT*TEST*AC',lat:45.5,lon:9.5,cpo:'Free To X',standard_connettore:'IEC_62196_T2',corrente:'AC',stato:'Attivo',publication_status:'PUBLISHED',potenza_w:22000},
   {id_evse:'IT*TEST*DC',lat:45.5,lon:9.5,cpo:'Free To X',standard_connettore:'IEC_62196_T2_COMBO',corrente:'DC',stato:'Attivo',publication_status:'PUBLISHED',potenza_w:150000}]});
  if(url.includes('/table/'))return Response.json({code:'Ok',distances:[[0,250000,80000],[250000,0,170000],[80000,170000,0]]});
  if(url.includes('/route/')){
   const final=new URL(url).pathname.split('/').at(-1).split(';').length>2;
   const distances=final?[80000,170000]:[250000];
   return Response.json({code:'Ok',routes:[{distance:250000,duration:7200,legs:distances.map(distance=>({distance,duration:final?3600:7200})),geometry:{coordinates:[[9,45],[9.5,45.5],[10,46]]}}]});
  }return new Response(null,{status:503});
 };
 const result=(await another.rpc({origin:{lat:45,lon:9},destination:{lat:46,lon:10},batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},{scope,name:'plan_smart_trip'})).result;
 assert.equal(result.status,'simulated_plan');const stop=result.itinerary.charging_plan.stops[0];
 assert.equal(stop.connectorType,'CCS2');assert.equal(stop.tariff_source,'unknown');assert.equal(result.charging_recommendation.ac_charging.enabled,false);
 assert.ok(stop.theoretical_minimum_charging_minutes<=180);assert.ok(result.itinerary.legs.every(l=>l.reserve_met));
 assert.equal(result.navigation.automatic_dispatch,false);assert.ok(result.navigation.saved_plan.id);
 const saved=(await make().rpc({id:result.navigation.saved_plan.id,destinationIndex:1},{scope,name:'get_planned_trip'})).result;
 assert.equal(saved.navigation_handoff.command_request,null);assert.equal(saved.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.equal(saved.single_destination_fallback_allowed,false);assert.equal(saved.navigation_handoff.automatic_dispatch,false);
 assert.equal(f.teslaCalls()+another.teslaCalls(),0);
 assert.ok(db.calls.some(c=>c[0]==='EVAL'&&c[1].includes('SET')));
});

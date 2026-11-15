import test from 'node:test';import assert from 'node:assert/strict';
import {invokeRoadTrip} from './lib/road-trip.mjs';
import {planChargingRoadTrip} from './lib/charging-route.mjs';
import {tripNavigation} from './lib/trip-navigation.mjs';
test('public road planner rejects AC opt-in before any provider request',async()=>{
 await assert.rejects(planChargingRoadTrip({allowAcCharging:true},{fetcher:()=>assert.fail('provider called')}),/invalid_map_arguments/);
});
test('explicit area query retains only mapped Type 2 AC, without Tesla, Overpass or road-plan claims',async()=>{
 const fetcher=async url=>{
  assert.doesNotMatch(url,/tesla\.com|fleet-api|overpass|osrm/);
  if(!url.includes('cruscotto-italia.dati.gov.it'))return new Response(null,{status:503});
  const row={id_evse:'IT*TEST*AC',lat:45.465,lon:9.19,cpo:'Free To X',standard_connettore:'IEC_62196_T2',corrente:'AC',stato:'Attivo',publication_status:'PUBLISHED',potenza_w:22000};
  return Response.json({_source:'GSE PUN',_source_url:'https://www.piattaformaunicanazionale.it/idr',_license:'CC BY 4.0',_snapshot_date:new Date().toISOString().slice(0,10),_generated_at:new Date().toISOString(),punti:[row,{...row,id_evse:'DC',standard_connettore:'IEC_62196_T2_COMBO',corrente:'DC'},{...row,id_evse:'far',lat:46}]});
 };
 const r=await invokeRoadTrip('find_charging_sites',{center:{lat:45.4642,lon:9.19},radiusKm:5,connectorType:'AC',externalMapsConsent:true},{fetcher});
 assert.equal(r.sites.length,1);assert.equal(r.sites[0].connectorType,'AC');assert.equal(r.sites[0].ccs2,false);assert.ok(r.sites[0].source_url);assert.equal(r.coverage_complete,false);assert.equal(r.sent_to_vehicle,false);assert.equal(r.vehicle_read_performed,false);
});
test('an old saved AC itinerary cannot prepare road-navigation handoff',async()=>{
 const data=new Map(),plans=tripNavigation({store:{put:async(k,v)=>data.set(k,v),get:async k=>data.get(k)},config:{issuer:'fixture',key:Buffer.alloc(32,7)}});
 const saved=await plans.save('owner',{destinations:[{lat:45,lon:9}],itinerary:{charging_plan:{feasible:true,stops:[{connectorType:'AC',ccs2:false}]}}});
 const r=await plans.get('owner',saved.id);assert.equal(r.navigation_handoff.available,false);assert.equal(r.navigation_handoff.command_request,null);assert.equal(r.navigation_handoff.reason,'ac_stops_not_allowed_for_road_trip');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {tripRouteHandoff,tripNavigation} from './lib/trip-navigation.mjs';
import {GPS_ROUTE_ORDER_SCHEMA} from './lib/gps-route-activation.mjs';
import {TESLA_P256_ORIGIN} from './lib/partner-p256-identity.mjs';

// Synthetic planned route: first point, DC stop, later point, repeated first
// point and final return. No geocoding or real vehicle operations.
const first={lat:45.5,lon:9.1},dc={lat:45.51,lon:9.11},last={lat:45.52,lon:9.12},home={lat:45.49,lon:9.09};
function saved(){return {created_at:'2026-11-05T15:00:00Z',destinations:[first,dc,last,first,home],itinerary:{
 energy:{inputs:{usableCapacityKwh:68,reservePercent:15}},
 charging_plan:{feasible:true,policy:{reserve_percent:15},stops:[{...dc,id:'synthetic-dc',ccs2:true,after_leg:1}]},
 legs:[20,18,16,13,10.5].map(arrival_kwh=>({arrival_kwh,reserve_met:true}))
}};}
const enabled={candidateEnabled:true};
test('whole-route preparation preserves charging stop, duplicates and return without mutating the single handoff',()=>{
 const input=saved(),before=structuredClone(input),r=tripRouteHandoff(input,enabled);
 assert.equal(r.available,true);assert.deepEqual(r.command_request,{operation:'navigation_gps_request',arguments:{points:[first,dc,last,first,home]}});
 assert.equal(r.automatic_dispatch,false);assert.equal(r.requires_explicit_user_request,true);assert.equal(r.experimental,true);
 assert.equal(r.atomic,false);assert.equal(r.vehicle_route_verified,false);assert.equal(r.battery_preconditioning_verified,false);
 assert.equal(r.energy_verification_basis,'SAVED_PLAN_NOT_CURRENT_VEHICLE');assert.equal(r.requires_replanning_if_conditions_changed,true);
 r.command_request.arguments.points[0].lat=0;assert.deepEqual(input,before);
});
test('default-off never supplies an executable route even with a feasible saved plan',()=>{
 for(const options of [undefined,{candidateEnabled:false},{candidateEnabled:'true'}]){
  const r=tripRouteHandoff(saved(),options);assert.equal(r.available,false);assert.equal(r.command_request,null);assert.equal(r.reason,'gps_route_candidate_disabled');
 }
});
test('no partial route is produced for invalid or excessive destinations',()=>{
 for(const points of [[first],Array.from({length:17},()=>first),[first,{lat:91,lon:9}],null]){
  const p=saved();p.destinations=points;assert.equal(tripRouteHandoff(p,enabled).command_request,null);
 }
});
test('a feasible label cannot hide an unverified DC stop or reserve breach',()=>{
 const mutations=[p=>p.itinerary.charging_plan.feasible=null,p=>p.itinerary.charging_plan.stops=[{connectorType:'AC'}],
  p=>p.itinerary.charging_plan.stops=[{}],p=>p.itinerary.charging_plan.stops[0].connectorType='AC',
  p=>p.itinerary.charging_plan.stops[0].after_leg=0,p=>p.itinerary.charging_plan.stops[0].lat=46,
  p=>p.itinerary.charging_plan.stops.push({...p.itinerary.charging_plan.stops[0]}),p=>p.itinerary.legs.pop(),p=>p.itinerary.legs[0].reserve_met=false,
  p=>p.itinerary.legs[4].arrival_kwh=10.499999,p=>delete p.itinerary.legs[0].arrival_kwh,
  p=>p.itinerary.charging_plan.policy.reserve_percent=14,p=>p.itinerary.energy.inputs.reservePercent=20,
  p=>delete p.itinerary.energy];
 for(const mutate of mutations){const p=saved();mutate(p);const r=tripRouteHandoff(p,enabled);assert.equal(r.available,false);assert.equal(r.command_request,null);}
});
test('encrypted persisted plan requires all production gates, retains account and expiry isolation',async()=>{
 const rows=new Map(),store={put:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)??null};
 let time=Date.parse('2026-11-05T15:00:00Z');
 const config={issuer:'fixture',key:Buffer.alloc(32,8),origin:TESLA_P256_ORIGIN,env:{APP_ORIGIN:TESLA_P256_ORIGIN,TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'true',TESLA_GPS_ROUTE_ORDER_SCHEMA:GPS_ROUTE_ORDER_SCHEMA,
  TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',VERCEL_ENV:'production',TESLA_REAL_RELEASE_APPROVED:'true'}};
 const plans=tripNavigation({store,config,now:()=>time}),ref=await plans.save('owner',saved());
 const r=await plans.get('owner',ref.id,{destinationIndex:2});
 assert.equal(r.multi_stop_navigation_handoff.available,true);assert.equal(r.requires_explicit_request_per_destination,false);
 assert.deepEqual(r.multi_stop_navigation_handoff.command_request.arguments.points,[first,dc,last,first,home]);
 assert.equal(r.navigation_handoff.command_request,null);assert.equal(r.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.equal(r.single_destination_fallback_allowed,false);assert.equal(r.sent_to_vehicle,false);
 for(const patch of [{TESLA_GPS_ROUTE_CANDIDATE_ENABLED:undefined},{TESLA_GPS_ROUTE_ORDER_SCHEMA:'unknown'},{VERCEL_ENV:'preview'},{TESLA_REAL_RELEASE_APPROVED:'false'}]){
  const off=tripNavigation({store,config:{...config,env:{...config.env,...patch}},now:()=>time});
  const read=await off.get('owner',ref.id);assert.equal(read.multi_stop_navigation_handoff.command_request,null);
  assert.equal(read.navigation_handoff.command_request,null);assert.equal(read.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
 }
 assert.equal((await plans.get('other-owner',ref.id)).available,false);
 assert.doesNotMatch(JSON.stringify([...rows.values()]),/synthetic-dc|destinations|45\.51/);
 time+=86400001;assert.equal((await plans.get('owner',ref.id)).available,false);
});
test('single-destination saved plan preserves the existing navigation_request handoff',async()=>{
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)};
 const plans=tripNavigation({store,config:{issuer:'fixture',key:Buffer.alloc(32,8)}});
 const point={lat:45.5,lon:9.1};
 const saved=await plans.save('owner',{destinations:[point],itinerary:{charging_plan:{feasible:true}}});
 const result=await plans.get('owner',saved.id);
 assert.equal(result.navigation_handoff.command_request.operation,'navigation_request');
 assert.deepEqual(result.navigation_handoff.command_request.arguments,{destination:'45.5, 9.1'});
 assert.equal(result.single_destination_fallback_allowed,true);
});
test('natural multipoint requires configured place IDs and uses the separately gated GPS candidate for OSM names',async()=>{
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)};
 const config={issuer:'fixture',key:Buffer.alloc(32,8),origin:TESLA_P256_ORIGIN,env:{APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',TESLA_NATIVE_WAYPOINTS_ENABLED:'true'}};
 const input=saved();input.destinations=[first,last];input.itinerary.charging_plan.stops=[];input.itinerary.legs=[20,18].map(arrival_kwh=>({arrival_kwh,reserve_met:true}));
 input.requires_verified_waypoint_identity=true;input.resolved_route={origin:null,stops:['Example One'],destination:'Example Two',roundTrip:false};
 const plans=tripNavigation({store,config}),ref=await plans.save('owner',input),result=await plans.get('owner',ref.id);
 assert.equal(result.multi_stop_navigation_handoff.command_request,null);
 assert.equal(result.multi_stop_navigation_handoff.available,false);
 const gpsConfig={...config,env:{...config.env,TESLA_NATIVE_WAYPOINTS_ENABLED:'false',TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'true',TESLA_GPS_ROUTE_ORDER_SCHEMA:GPS_ROUTE_ORDER_SCHEMA}};
 const gpsPlans=tripNavigation({store,config:gpsConfig}),gpsRef=await gpsPlans.save('owner',{...input,resolved_route:{stops:['POI uno'],destination:'POI due'}}),gps=await gpsPlans.get('owner',gpsRef.id);
 assert.equal(gps.multi_stop_navigation_handoff.command_request.operation,'navigation_gps_request');assert.equal(gps.multi_stop_navigation_handoff.api_actuation_count,2);
 assert.deepEqual(gps.multi_stop_navigation_handoff.command_request.arguments.points,input.destinations);assert.equal(gps.sent_to_vehicle,false);
});

test('navigation-only OSM routes prepare ordered GPS candidates for two, three and four stops without a charging plan',async()=>{
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)};
 const config={issuer:'fixture',key:Buffer.alloc(32,9),origin:TESLA_P256_ORIGIN,env:{APP_ORIGIN:TESLA_P256_ORIGIN,
  VERCEL_ENV:'production',TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',
  TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',
  TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'true',TESLA_GPS_ROUTE_ORDER_SCHEMA:GPS_ROUTE_ORDER_SCHEMA}};
 for(const count of [2,3,4]){
  const destinations=Array.from({length:count},(_,i)=>({lat:45.5+i/100,lon:9.1+i/100}));
  const names=Array.from({length:count},(_,i)=>'Luogo OSM '+i);
  const evidence=destinations.map((_,i)=>({query:names[i],source:'PHOTON_OSM',osm_id:100+i,osm_type:'way',
   source_url:'https://www.openstreetmap.org/way/'+(100+i),coordinate_status:'unique_public_map_match_not_user_confirmed'}));
  const route={origin:null,stops:names.slice(0,-1),destination:names.at(-1),roundTrip:false};
  const saved={navigation_only:true,destinations,place_evidence:evidence,requested_route:route,resolved_route:route,
   requires_verified_waypoint_identity:true,itinerary:{navigation_only:true}};
  const plans=tripNavigation({store,config}),ref=await plans.save('owner-'+count,saved);
  const result=await plans.get('owner-'+count,ref.id);
  assert.equal(result.multi_stop_navigation_handoff.available,true);
  assert.equal(result.multi_stop_navigation_handoff.command_request.operation,'navigation_gps_request');
  assert.deepEqual(result.multi_stop_navigation_handoff.command_request.arguments.points,destinations);
  assert.equal(result.multi_stop_navigation_handoff.api_actuation_count,count);
  assert.equal(result.multi_stop_navigation_handoff.single_destination_fallback_allowed,false);
  assert.equal(result.multi_stop_navigation_handoff.vehicle_route_verified,false);
  assert.equal(result.navigation_handoff.command_request,null);
 }
});

test('navigation-only route stays blocked without its gate and rejects unverified map coordinates',async()=>{
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)};
 const points=[{lat:45.5,lon:9.1},{lat:45.6,lon:9.2}],names=['POI uno','POI due'];
 const route={origin:null,stops:[names[0]],destination:names[1],roundTrip:false};
 const saved={navigation_only:true,destinations:points,place_evidence:points.map((_,i)=>({source:'PHOTON_OSM',
  osm_id:200+i,osm_type:'node',source_url:'https://www.openstreetmap.org/node/'+(200+i),
  coordinate_status:'unique_public_map_match_not_user_confirmed'})),resolved_route:route,
  requested_route:route,requires_verified_waypoint_identity:true,itinerary:{navigation_only:true}};
 const config={issuer:'fixture',key:Buffer.alloc(32,9)};
 const plans=tripNavigation({store,config}),ref=await plans.save('owner',saved),blocked=await plans.get('owner',ref.id);
 assert.equal(blocked.multi_stop_navigation_handoff.available,false);
 assert.equal(blocked.multi_stop_navigation_handoff.single_destination_fallback_allowed,false);
 assert.equal(blocked.multi_stop_navigation_handoff.command_request,null);
 const bad={...saved,place_evidence:[saved.place_evidence[0],{source:'USER_SUPPLIED',coordinate_status:'supplied_not_independently_validated'}]};
 const badRef=await plans.save('owner',bad),rejected=await plans.get('owner',badRef.id);
 assert.equal(rejected.multi_stop_navigation_handoff.reason,'destination_coordinates_not_verified_from_osm_or_saved_place');
 assert.equal(rejected.multi_stop_navigation_handoff.command_request,null);
 const estimated={...saved,place_evidence:[saved.place_evidence[0],{...saved.place_evidence[1],coordinate_status:'street_segment_estimate'}]};
 const estimatedRef=await plans.save('owner',estimated),estimatedResult=await plans.get('owner',estimatedRef.id);
 assert.equal(estimatedResult.multi_stop_navigation_handoff.reason,'destination_coordinates_not_verified_from_osm_or_saved_place');
});

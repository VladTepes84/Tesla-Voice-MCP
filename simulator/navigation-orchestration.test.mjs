import test from 'node:test';
import assert from 'node:assert/strict';
import { planSmartTrip } from './lib/smart-trip.mjs';
import { invokeRoadTrip } from './lib/road-trip.mjs';
import { planChargingRoadTrip } from './lib/charging-route.mjs';
import { tripNavigation } from './lib/trip-navigation.mjs';
import { commandCatalog, prepareOperation } from './lib/operation-plans.mjs';

const now=()=>Date.parse('2026-11-04T12:00:00Z');
const observed_at=new Date(now()-60_000).toISOString();
const origin={lat:45.4642,lon:9.19},northville={lat:45.726,lon:9.073},laketown={lat:45.808,lon:9.085};
const fail=()=>assert.fail('unexpected vehicle/network operation');
const base={destination:laketown,origin,externalMapsConsent:true,teslaBatteryConsent:true};
const preferences={get:async()=>({initialized:true,preferences:{consumptionKwhPer100Km:13},updated_at:observed_at})};
const deps=patch=>({subject:'owner',now,maps:fail,plan:fail,backend:{preferences,withTripReadLease:f=>f(),vehicleReadingHistory:async()=>({readings:[]}),battery:fail,location:fail,...patch}});

test('GPS supplied and SOC unavailable retains origin without another GPS read',async()=>{
 const r=await planSmartTrip(base,deps({battery:async()=>{throw Error('vehicle_unavailable');}}));
 assert.equal(r.status,'vehicle_data_unavailable');assert.equal(r.stage,'battery');
 assert.deepEqual(r.available_origin,{...origin,source:'USER_SUPPLIED'});assert.equal(r.sent_to_vehicle,false);
});
for(const reason of ['vehicle_unavailable','busy','upstream'])test('sleep/offline/temporary '+reason+' does not wake or retry',async()=>{
 let reads=0;const r=await planSmartTrip({...base,batteryMode:'live'},deps({battery:async()=>{reads++;throw Error(reason);}}));
 assert.equal(r.reason,reason);assert.equal(reads,1);assert.equal(r.status,'vehicle_data_unavailable');
});
test('temporary live failure uses only explicit, recent cache fallback and reports its age',async()=>{
 const d=deps({battery:async()=>{throw Error('upstream');},vehicleReadingHistory:async()=>({readings:[{source:'TESLA_CACHED',battery_percent:39,observed_at}]})});
 const r=await planSmartTrip({...base,batteryMode:'live',allowCachedFallback:true},{...d,plan:async()=>({charging_plan:{feasible:true}})});
 assert.equal(r.battery.quality,'recent_app_cache_fallback');assert.equal(r.battery.data_age_seconds,60);
});
for(const gps of [
 {source:'TESLA_LIVE',latitude:45,longitude:9,observed_at:new Date(now()-16*60_000).toISOString()},
 {source:'TESLA_LIVE',latitude:45,longitude:9,observed_at:new Date(now()+1000).toISOString()},
 {source:'TESLA_LIVE',latitude:NaN,longitude:9,observed_at},
 {source:'UNTRUSTED',latitude:45,longitude:9,observed_at}
])test('invalid/stale/future/unattributed GPS never enters routing '+JSON.stringify(gps),async()=>{
 const r=await planSmartTrip({destination:laketown,batteryPercent:39,simulatedBattery:true,externalMapsConsent:true,teslaLocationConsent:true},deps({location:async()=>gps}));
 assert.equal(r.status,'needs_fresh_location');
});

function feature(point,name,patch={}) {
 return {geometry:{coordinates:[point.lon,point.lat]},properties:{name,city:name,country:'Italia',state:'Lombardia',district:'Laketown',osm_key:'place',osm_value:'town',...patch}};
}
test('equivalent municipality candidates collapse; Laketown POI does not create false ambiguity',async()=>{
 for(const [query,point,name] of [['Northville, Lombardia',northville,'Northville'],['Laketown, Lombardia',laketown,'Laketown']]){
  const features=[feature(point,name),feature({...point,lat:point.lat+0.0001},name),feature(point,name,{osm_key:'amenity',osm_value:'restaurant'})];
  const r=await invokeRoadTrip('search_trip_destination',{query,externalMapsConsent:true},{fetcher:async()=>Response.json({features})});
  assert.equal(r.selection_required,false);assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].name,name);
 }
});
test('distinct homonymous municipalities still require selection',async()=>{
 const r=await invokeRoadTrip('search_trip_destination',{query:'Laketown',externalMapsConsent:true},{fetcher:async()=>Response.json({features:[feature(laketown,'Laketown'),feature({lat:40,lon:8},'Laketown',{state:'Another region'})]})});
 assert.equal(r.selection_required,true);assert.equal(r.candidates.length,2);
});

test('Northville then Laketown then captured origin plans and persists without any command',async()=>{
 const rows=new Map(),store={put:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)??null};
 const config={issuer:'fixture',key:Buffer.alloc(32,8)},tripPlans=tripNavigation({store,config,now});
 const d=deps({tripPlans,battery:async()=>({source:'TESLA_CACHED',battery_percent:39,observed_at}),location:async()=>({source:'TESLA_LIVE',latitude:origin.lat,longitude:origin.lon,observed_at})});
 const maps=async(_name,{query})=>({candidates:[{...(query.startsWith('Northville')?northville:laketown),name:query.startsWith('Northville')?'Northville':'Laketown',state:'Lombardia',country:'Italia',osm_key:'place',osm_value:'town'}]});
 const r=await planSmartTrip({destination:'Laketown, Lombardia',stops:['Northville, Lombardia'],roundTrip:true,
  routePreferences:{avoidTolls:true,avoidMotorways:true,preferredRoads:['SS35 dei Giovi']},chargingRange:{minimumPercent:45,maximumPercent:70},
  externalMapsConsent:true,teslaBatteryConsent:true,teslaLocationConsent:true},{...d,maps,plan:async(args,options)=>{
   assert.equal(options.freeToXContract,undefined);
   assert.deepEqual(args.routePreferences,{avoidTolls:true,avoidMotorways:true,preferredRoads:['SS35 dei Giovi']});
   return planChargingRoadTrip(args,{...options,fetcher:async url=>{
    assert.equal(new URL(url).hostname,'router.project-osrm.org');
    assert.equal(new URL(url).searchParams.get('exclude'),'motorway,toll');
    assert.ok(new URL(url).pathname.endsWith([origin,northville,laketown,origin].map(p=>p.lon+','+p.lat).join(';')));
    // Explicit synthetic road fixture, not a claim of current road distances.
    return Response.json({code:'Ok',routes:[{distance:65000,duration:3600,legs:[20000,15000,30000].map(distance=>({distance,duration:1200}))}]});
   }});
  }});
 assert.equal(r.status,'estimated_plan');assert.equal(r.sent_to_vehicle,false);
 assert.deepEqual(r.navigation.ordered_destinations,[northville,laketown,origin]);
 assert.equal(r.navigation.automatic_dispatch,false);assert.equal(r.navigation.multi_stop_transport_supported,false);
 assert.equal(r.navigation.command,null);assert.equal(r.navigation.handoff.available,false);assert.equal(r.navigation.handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.equal(r.navigation.iphone_app_sync,'not_verifiable');assert.ok(r.itinerary.charging_plan.estimated_arrival_kwh>=10.2);
 assert.equal(r.routing_preferences.planner_query_applied,true);assert.deepEqual(r.routing_preferences.requested,{avoidTolls:true,avoidMotorways:true,preferredRoads:['SS35 dei Giovi']});
 assert.deepEqual(r.routing_preferences.unsupported_preferences,['preferredRoads']);assert.equal(r.routing_preferences.applied_to_tesla,false);
 assert.equal(r.charging_range.applied_to_planner,false);
 const saved=await tripNavigation({store,config,now}).get('owner',r.navigation.saved_plan.id);
 assert.deepEqual(saved.destinations,[northville,laketown,origin]);assert.equal(saved.requires_explicit_request_per_destination,false);
 assert.equal(saved.navigation_handoff.command_request,null);assert.equal(saved.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.deepEqual(saved.requested_route,{origin:{source:'TESLA_GPS_CAPTURED',observed_at},stops:['Northville, Lombardia'],destination:'Laketown, Lombardia',roundTrip:true});
 assert.deepEqual(saved.requested_route_preferences,{avoidTolls:true,avoidMotorways:true,preferredRoads:['SS35 dei Giovi']});
 assert.deepEqual(saved.requested_charging_range,{minimumPercent:45,maximumPercent:70});
 assert.equal((await tripPlans.get('another-owner',r.navigation.saved_plan.id)).available,false);
 assert.doesNotMatch(JSON.stringify([...rows.values()]),/latitude|destinations|65000|freeToX/);
});
test('identical waypoint queries are geocoded once and a multi-stop plan never exposes navigation_request',async()=>{
 const repeated='Laketown, Lombardia';let searches=0,planned;
 const backend={preferences:{get:async()=>({preferences:{}})}};
 const r=await planSmartTrip({origin,destination:repeated,stops:[repeated,repeated],batteryPercent:39,simulatedBattery:true,externalMapsConsent:true,
  routePreferences:{avoidTolls:true},chargingRange:{minimumPercent:45,maximumPercent:70}},{subject:'owner',backend,
  maps:async()=>{searches++;return{source:'PHOTON_OSM',provider_calls:1,candidates:[{...laketown,name:'Laketown',city:'Laketown',country:'Italia',state:'Lombardia',osm_key:'place',osm_value:'town'}]};},
  plan:async args=>{planned=args;return{charging_plan:{feasible:true},navigation_destinations:[args.stops[0],args.stops[1],args.destination]};}});
 assert.equal(searches,1);assert.equal(r.map_metrics.unique_queries,1);assert.equal(r.map_metrics.duplicate_queries,2);
 assert.equal(r.map_metrics.provider_calls,1);assert.equal(r.map_metrics.cache_hit_rate,0);
 assert.deepEqual(planned.stops,[laketown,laketown]);assert.deepEqual(r.navigation.ordered_destinations,[laketown,laketown,laketown]);
 assert.equal(r.navigation.handoff.command_request,null);assert.equal(r.navigation.command,null);assert.equal(r.sent_to_vehicle,false);
});
for(const count of [3,4])test(`${count} natural destinations retain order and never downgrade to a single destination`,async()=>{
 const rows=new Map(),store={put:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)??null},config={issuer:'fixture',key:Buffer.alloc(32,8)};
 const tripPlans=tripNavigation({store,config,now}),names=Array.from({length:count},(_,i)=>`Stop ${i+1}`),places=names.map((_,i)=>({lat:45+i/100,lon:9+i/100}));
 let searches=0,planned;
 const backend={tripPlans,preferences:{get:async()=>({initialized:false,preferences:{}})}};
 const maps=async(_name,{query})=>{searches++;const i=names.indexOf(query);return{source:'PHOTON_OSM',provider_calls:1,candidates:[{...places[i],name:query,city:'Laketown',country:'Italia',osm_type:'N',osm_id:700+i,source:'PHOTON_OSM'}]};};
 const r=await planSmartTrip({origin,stops:names.slice(0,-1),destination:names.at(-1),batteryPercent:55,simulatedBattery:true,externalMapsConsent:true,
  routePreferences:{avoidHighways:true,avoidTolls:true}},{subject:'owner',backend,maps,plan:async args=>{
   planned=args;return{charging_plan:{feasible:true},navigation_destinations:[...args.stops,args.destination]};
  }});
 assert.equal(searches,count);assert.deepEqual(planned.stops,places.slice(0,-1));assert.deepEqual(r.navigation.ordered_destinations,places);
 assert.equal(r.navigation.command,null);assert.equal(r.navigation.handoff.command_request,null);assert.equal(r.sent_to_vehicle,false);
 assert.equal(r.navigation.saved_plan.multi_stop_candidate_available,false);
 const saved=await tripPlans.get('owner',r.navigation.saved_plan.id);
 assert.deepEqual(saved.destinations,places);assert.equal(saved.requires_verified_waypoint_identity,true);
 assert.equal(saved.multi_stop_navigation_handoff.reason,'dc_stops_not_verified');
 assert.equal(saved.navigation_handoff.command_request,null);assert.equal(saved.single_destination_fallback_allowed,false);
});
test('ambiguous stop persists the whole itinerary and continuation selects without re-geocoding other places',async()=>{
 const rows=new Map(),store={put:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)??null},config={issuer:'fixture',key:Buffer.alloc(32,8)};
 const tripPlans=tripNavigation({store,config,now}),carrefour=[
  {lat:45.55,lon:9.18,name:'Example Charger Nord',city:'Exampletown',state:'Lombardia',country:'Italia',street:'SP35 dei Giovi',operator:'Ewiva',osm_type:'N',osm_id:111,source:'PHOTON_OSM'},
  {lat:45.56,lon:9.19,name:'Example Charger Sud',city:'Exampletown',state:'Lombardia',country:'Italia',street:'SP35 dei Giovi',operator:'Ewiva',osm_type:'N',osm_id:112,source:'PHOTON_OSM'}
 ];let searches=0,planned;
 const backend={tripPlans,preferences:{get:async()=>({initialized:false,preferences:{}})}};
 const maps=async(_name,{query})=>{searches++;return{source:'PHOTON_OSM',provider_calls:1,candidates:query.startsWith('Example')?carrefour:[{...laketown,name:'Laketown',city:'Laketown',state:'Lombardia',country:'Italia',osm_key:'place',osm_value:'town',source:'PHOTON_OSM'}]};};
 const routeInput={origin,stops:['Example Charger'],destination:'Laketown, Lombardia',batteryPercent:39,simulatedBattery:true,
  externalMapsConsent:true,routePreferences:{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']},chargingRange:{minimumPercent:45,maximumPercent:70}};
 const first=await planSmartTrip(routeInput,{backend,subject:'owner',now,maps,plan:async()=>assert.fail('must not plan before ambiguity is resolved')});
 assert.equal(first.status,'needs_place_selection');assert.equal(first.continuation_state_saved,true);assert.equal(first.places.length,1);
 assert.equal(first.places[0].placeIndex,1);assert.equal(first.places[0].candidates.length,2);
 assert.equal('lat' in first.places[0].candidates[0],false);assert.equal(searches,2);
 const second=await planSmartTrip({externalMapsConsent:true,continuationId:first.continuation_id,placeSelections:[{placeIndex:1,candidateIndex:0}]},
  {backend,subject:'owner',now,maps,plan:async args=>{planned=args;return{charging_plan:{feasible:true},navigation_destinations:[args.stops[0],args.destination]};}});
 assert.equal(second.status,'simulated_plan');assert.equal(searches,2);assert.deepEqual(planned.stops,[{lat:45.55,lon:9.18}]);
 assert.equal(second.navigation.command,null);assert.equal(second.navigation.handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.equal(second.map_metrics.clarification_count,1);assert.equal(second.sent_to_vehicle,false);
 const saved=await tripPlans.get('owner',second.navigation.saved_plan.id);
 assert.deepEqual(saved.requested_route, {origin,stops:['Example Charger'],destination:'Laketown, Lombardia',roundTrip:false});
 assert.equal(saved.place_evidence[1].coordinate_status,'user_selected_map_candidate_not_exact_coordinate_confirmation');
 assert.deepEqual(saved.requested_route_preferences,routeInput.routePreferences);assert.deepEqual(saved.requested_charging_range,routeInput.chargingRange);
});
test('resolved route survives a routing-provider outage and continuation reuses resolved places and preferences',async()=>{
 const rows=new Map(),store={put:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)??null},config={issuer:'fixture',key:Buffer.alloc(32,8)};
 const tripPlans=tripNavigation({store,config,now}),backend={tripPlans,preferences:{get:async()=>({preferences:{}})}};
 let searches=0;const routeInput={origin,destination:'Laketown, Lombardia',stops:['Northville, Lombardia'],batteryPercent:39,simulatedBattery:true,
  externalMapsConsent:true,routePreferences:{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']},chargingRange:{minimumPercent:45,maximumPercent:70}};
 const maps=async(_name,{query})=>{searches++;const isNorthville=query.startsWith('Northville');const point=isNorthville?northville:laketown;const name=isNorthville?'Northville':'Laketown';
  return{source:'PHOTON_OSM',candidates:[{...point,name,city:name,state:'Lombardia',country:'Italia',osm_key:'place',osm_value:'town'}]};};
 const interrupted=await planSmartTrip(routeInput,{backend,subject:'owner',now,maps,plan:async()=>{throw Error('map_provider_unavailable');}});
 assert.equal(interrupted.status,'maps_unavailable');assert.equal(interrupted.route_context_persisted,true);assert.ok(interrupted.route_continuation_id);
 const searchesBeforeResume=searches;
 const resumed=await planSmartTrip({externalMapsConsent:true,continuationId:interrupted.route_continuation_id},{backend,subject:'owner',now,maps,
  plan:async args=>({charging_plan:{feasible:true},navigation_destinations:[...args.stops,args.destination]})});
 assert.equal(searches,searchesBeforeResume);assert.deepEqual(resumed.navigation.ordered_destinations,[northville,laketown]);
 const saved=await tripPlans.get('owner',resumed.navigation.saved_plan.id);
 assert.deepEqual(saved.requested_route_preferences,routeInput.routePreferences);assert.deepEqual(saved.requested_charging_range,routeInput.chargingRange);
});
test('itinerary stays retrievable when energy feasibility is unknown, with navigation still blocked',async()=>{
 const rows=new Map(),store={put:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)??null},config={issuer:'fixture',key:Buffer.alloc(32,8)};
 const tripPlans=tripNavigation({store,config,now}),backend={tripPlans,preferences:{get:async()=>({preferences:{}})}};
 const result=await planSmartTrip({origin,destination:'Laketown, Lombardia',batteryPercent:39,simulatedBattery:true,externalMapsConsent:true,
  routePreferences:{avoidTolls:true},chargingRange:{minimumPercent:45,maximumPercent:70}},{subject:'owner',now,backend,
  maps:async()=>({source:'PHOTON_OSM',candidates:[{...laketown,name:'Laketown',city:'Laketown',state:'Lombardia',country:'Italia',osm_key:'place',osm_value:'town'}]}),
  plan:async args=>({charging_plan:{feasible:null},navigation_destinations:[args.destination]})});
 assert.equal(result.status,'charging_unverified');assert.ok(result.navigation.saved_plan.id);
 const saved=await tripPlans.get('owner',result.navigation.saved_plan.id);
 assert.deepEqual(saved.requested_route_preferences,{avoidTolls:true});assert.deepEqual(saved.requested_charging_range,{minimumPercent:45,maximumPercent:70});
 assert.equal(saved.navigation_handoff.available,false);assert.equal(saved.navigation_handoff.reason,'energy_not_verified');
});
test('saving failure returns the computed itinerary with explicit persistence limitation',async()=>{
 const d=deps({tripPlans:{save:async()=>{throw Error('store');}}});
 const r=await planSmartTrip({...base,batteryPercent:39,simulatedBattery:true},{...d,plan:async()=>({charging_plan:{feasible:true}})});
 assert.equal(r.status,'simulated_plan');assert.equal(r.navigation.saved_plan.reason,'itinerary_storage_unavailable');
});
test('waypoints stay explicitly unsupported and single destination remains supported',()=>{
 const catalog=commandCatalog({executionEnabled:true});
 const serialized=JSON.stringify(catalog);assert.ok(serialized.includes('navigation_waypoints_request'));
 assert.throws(()=>prepareOperation('navigation_waypoints_request',{}),/unsupported/);
 assert.equal(prepareOperation('navigation_request',{destination:'Laketown, Lombardia'}).operation,'navigation_request');
});

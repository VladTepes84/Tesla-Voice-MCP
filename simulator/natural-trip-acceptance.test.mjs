import test from 'node:test';
import assert from 'node:assert/strict';
import { planSmartTrip } from './lib/smart-trip.mjs';

const origin={lat:45.55,lon:9.17},home={lat:45.58,lon:9.2};
const baseBackend=(patch={})=>({preferences:{get:async()=>({initialized:false,preferences:{}})},...patch});
const mapCandidate=(query,coords,patch={})=>({source:'PHOTON_OSM',provider_calls:1,candidates:[{
 ...coords,name:query,city:'Laketown',state:'Lombardia',country:'Italia',osm_key:'place',osm_value:'city',...patch
}]});
const plan=async args=>({charging_plan:{feasible:true},navigation_destinations:[...args.stops,args.destination]});

test('A — city destination resolves without asking for an address and preserves single navigation',async()=>{
 let queries=0,planned;
 const result=await planSmartTrip({origin,destination:'Laketown',batteryPercent:55,simulatedBattery:true,externalMapsConsent:true},{subject:'owner',
  backend:baseBackend(),maps:async(_name,{query})=>{queries++;assert.equal(query,'Laketown');return mapCandidate(query,{lat:45.808,lon:9.085});},
  plan:async args=>{planned=args;return plan(args);}});
 assert.equal(queries,1);assert.deepEqual(planned.destination,{lat:45.808,lon:9.085});
 assert.equal(result.navigation.command,'navigation_request');assert.equal(result.navigation.handoff.available,true);assert.equal(result.sent_to_vehicle,false);
});

test('B — Ewiva/Carrefour query resolves from operator, POI name, and municipality together',async()=>{
 let planned;
 const candidate={lat:45.566,lon:9.16,name:'Example Charger',city:'Exampletown',state:'Lombardia',country:'Italia',
  street:'SP35 dei Giovi',operator:'Ewiva',osm_key:'amenity',osm_value:'charging_station',osm_id:9001,osm_type:'N',source_url:'https://www.openstreetmap.org/node/9001',source:'PHOTON_OSM'};
 const result=await planSmartTrip({origin,destination:'Example Charger',batteryPercent:55,simulatedBattery:true,externalMapsConsent:true},{subject:'owner',
  backend:baseBackend(),maps:async()=>({source:'PHOTON_OSM',provider_calls:1,candidates:[candidate]}),
  plan:async args=>{planned=args;return{charging_plan:{feasible:true},navigation_destinations:[args.destination]};}});
 assert.deepEqual(planned.destination,{lat:candidate.lat,lon:candidate.lon});assert.equal(result.status,'simulated_plan');
 assert.equal(result.place_evidence[1].source_url,'https://www.openstreetmap.org/node/9001');
 assert.equal(result.place_evidence[1].coordinate_status,'unique_public_map_match_not_user_confirmed');
 assert.equal(result.navigation.handoff.available,true);assert.equal(result.sent_to_vehicle,false);
});

test('D — Casa is private and an ordered three-destination trip retains Via Sample and charge preferences',async()=>{
 const queries=[],planned=[];
 const backend=baseBackend({savedTripPlaces:{get:async()=>({places:{home},source:'USER_CONFIRMED_ACCOUNT'})}});
 const candidates={
  'Via Example 77, Exampleville':{lat:45.57,lon:9.16,name:'Via Example',city:'Exampleville',state:'Lombardia',country:'Italia',street:'Via Example',house_number:'77',osm_id:1,osm_type:'W',source:'PHOTON_OSM'},
  'Example Charger':{lat:45.566,lon:9.17,name:'Example Charger',city:'Exampletown',state:'Lombardia',country:'Italia',street:'SP35 dei Giovi',operator:'Ewiva',osm_key:'amenity',osm_value:'charging_station',osm_id:2,osm_type:'N',source:'PHOTON_OSM'},
  'Via Sample 40, Laketown':{lat:45.808,lon:9.085,name:'Via Sample',city:'Laketown',state:'Lombardia',country:'Italia',street:'Via Sample',house_number:'40',osm_id:3,osm_type:'W',source:'PHOTON_OSM'}
 };
 const result=await planSmartTrip({origin:'Via Example 77, Exampleville',stops:['Example Charger','Via Sample 40, Laketown'],destination:'Casa',
  batteryPercent:55,simulatedBattery:true,externalMapsConsent:true,routePreferences:{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']},
  chargingRange:{minimumPercent:45,maximumPercent:70}},{subject:'owner',backend,maps:async(_name,{query})=>{queries.push(query);return{source:'PHOTON_OSM',provider_calls:1,candidates:[candidates[query]]};},
  plan:async args=>{planned.push(args);return{charging_plan:{feasible:true},navigation_destinations:[...args.stops,args.destination]};}});
 assert.deepEqual(queries,Object.keys(candidates));assert.equal(queries.includes('Casa'),false);
 assert.deepEqual([planned[0].stops[0],planned[0].stops[1],planned[0].destination],[{lat:45.566,lon:9.17},{lat:45.808,lon:9.085},home]);
 assert.deepEqual(result.navigation.ordered_destinations,[{lat:45.566,lon:9.17},{lat:45.808,lon:9.085},home]);
 assert.equal(result.navigation.command,null);assert.equal(result.navigation.handoff.command_request,null);
 assert.deepEqual(result.routing_preferences.requested,{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']});
 assert.equal(result.routing_preferences.planner_query_applied,false);assert.equal(result.charging_range.applied_to_planner,false);assert.equal(result.sent_to_vehicle,false);
});

test('E — four ordered destinations survive no-highway/toll preferences without a single-stop fallback',async()=>{
 const locations=['Exampletown','Saronno','Laketown'];const coords=[{lat:45.566,lon:9.17},{lat:45.625,lon:9.036},{lat:45.808,lon:9.085}];
 const result=await planSmartTrip({origin,destination:'Casa',stops:locations,batteryPercent:55,simulatedBattery:true,externalMapsConsent:true,
  routePreferences:{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']}},{subject:'owner',
  backend:baseBackend({savedTripPlaces:{get:async()=>({places:{home},source:'USER_CONFIRMED_ACCOUNT'})}}),
  maps:async(_name,{query})=>mapCandidate(query,coords[locations.indexOf(query)],{city:query,osm_key:'place',osm_value:'town'}),
  plan:async args=>({charging_plan:{feasible:true},navigation_destinations:[...args.stops,args.destination]})});
 assert.deepEqual(result.navigation.ordered_destinations,[...coords,home]);assert.equal(result.navigation.ordered_destinations.length,4);
 assert.equal(result.navigation.command,null);assert.equal(result.navigation.next_destination,null);
 assert.equal(result.routing_preferences.planner_query_applied,false);assert.equal(result.sent_to_vehicle,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseChargingPath, planChargingRoadTrip } from './lib/charging-route.mjs';
const input={origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:true,batteryPercent:50,usableCapacityKwh:50,consumptionKwhPer100Km:20,reservePercent:10,chargingTargetPercent:80,maxChargingStops:4,externalMapsConsent:true};
const distances=[[0,150000,80000],[150000,0,70000],[80000,70000,0]];
test('road-distance search reuses a charger on return while preserving energy across the destination',()=>{
  const r=chooseChargingPath({...input,distances});
  assert.equal(r.found,true);assert.deepEqual(r.path,[0,2,1,2,0]);assert.equal(r.charging_stops,2);
});
test('stop bound and disconnected roads return no plan rather than invented reachability',()=>{
  assert.equal(chooseChargingPath({...input,maxChargingStops:1,distances}).found,false);
  assert.equal(chooseChargingPath({...input,distances:[[0,null],[null,0]]}).found,false);
});
test('selection prioritizes fewer charges before distance, then the shorter road route',()=>{
  const matrix=[[0,200000,50000,40000],[200000,0,100000,180000],[50000,100000,0,1000],[40000,180000,1000,0]];
  const args={...input,roundTrip:false,distances:matrix};
  // 0-3-2-1 is shorter but needs two charges; 0-2-1 needs only one.
  assert.deepEqual(chooseChargingPath(args).path,[0,2,1]);
  matrix[3][1]=100000;
  assert.deepEqual(chooseChargingPath(args).path,[0,3,1]);
});
test('automatic round trip uses mapped CCS sites, road matrix and final road-leg validation',async()=>{
  const calls=[];
  const result=await planChargingRoadTrip(input,{fetcher:async(url,opts)=>{
    calls.push(url);
    if(url.includes('/api/interpreter')) {
      assert.match(opts.body,/socket%3Atype2_combo/);
      return Response.json({elements:[{type:'node',id:123,lat:45.5,lon:9.5,tags:{operator:'Tesla',name:'Mapped charger','socket:type2_combo':'4'}}]});
    }
    if(url.includes('/table/'))return Response.json({code:'Ok',distances});
    if(calls.length===1)return Response.json({code:'Ok',routes:[{distance:300000,duration:20000,legs:[{distance:150000,duration:10000},{distance:150000,duration:10000}],geometry:{coordinates:[[9,45],[10,46],[9,45]]}}]});
    return Response.json({code:'Ok',routes:[{distance:300000,duration:20000,legs:[80000,70000,70000,80000].map(distance=>({distance,duration:5000}))}]});
  }});
  assert.equal(calls.length,4);assert.equal(result.charging_plan.feasible,true);
  assert.equal(result.charging_plan.stops.length,2);assert.equal(result.charging_plan.estimated_arrival_kwh,24);
  assert.equal(result.sent_to_vehicle,false);assert.equal(result.tariffs_verified,false);assert.equal(result.availability_verified,false);
  assert.equal(result.charging_plan.stops[0].source_url,'https://www.openstreetmap.org/node/123');
});
test('consent and energy validation happen before providers',async()=>{
  for(const args of [{...input,externalMapsConsent:false},{...input,usableCapacityKwh:undefined},{...input,chargingTargetPercent:5}])
    await assert.rejects(planChargingRoadTrip(args,{fetcher:()=>assert.fail('provider')}));
});
test('charging planner sends requested motorway/toll exclusions to the route profile and labels vehicle limits',async()=>{
 const requests=[];
 const result=await planChargingRoadTrip({...input,batteryPercent:100,routePreferences:{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']}},{fetcher:async url=>{
  requests.push(new URL(url));
  return Response.json({code:'Ok',routes:[{distance:10000,duration:600,legs:[{distance:5000,duration:300},{distance:5000,duration:300}]}]});
 }});
 assert.equal(requests.length,1);assert.equal(requests[0].searchParams.get('exclude'),'motorway,toll');
 assert.equal(result.routing_preferences.planner_query_applied,true);
 assert.deepEqual(result.routing_preferences.excluded_osrm_classes,['motorway','toll']);
 assert.deepEqual(result.routing_preferences.unsupported_preferences,['preferredRoads']);
 assert.equal(result.routing_preferences.applied_to_tesla,false);assert.equal(result.routing_preferences.real_world_avoidance_verified,false);
 assert.equal(result.sent_to_vehicle,false);
});
test('sufficient road-trip energy skips charger search entirely',async()=>{
  let calls=0;
  const r=await planChargingRoadTrip({...input,batteryPercent:100},{fetcher:async()=>{
    calls++;return Response.json({code:'Ok',routes:[{distance:100000,duration:10000,legs:[{distance:50000,duration:5000},{distance:50000,duration:5000}]}]});
  }});
  assert.equal(calls,1);assert.deepEqual(r.charging_plan.stops,[]);
});
test('final road route is rejected if its legs exceed the matrix energy estimate',async()=>{
  let calls=0;
  const r=await planChargingRoadTrip(input,{fetcher:async url=>{
    calls++;
    if(url.includes('/api/interpreter'))return Response.json({elements:[{type:'node',id:123,lat:45.5,lon:9.5,tags:{'socket:type2_combo':'yes'}}]});
    if(url.includes('/table/'))return Response.json({code:'Ok',distances});
    const segments=calls===1?[150000,150000]:[200000,70000,70000,80000];
    return Response.json({code:'Ok',routes:[{distance:segments.reduce((a,b)=>a+b),duration:20000,legs:segments.map(distance=>({distance,duration:5000})),geometry:{coordinates:[[9,45],[10,46],[9,45]]}}]});
  }});
  assert.equal(r.charging_plan.feasible,false);assert.equal(r.charging_plan.reason,'final_route_does_not_meet_reserve');
  assert.equal(r.sent_to_vehicle,false);
});

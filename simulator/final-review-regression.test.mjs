import test from 'node:test';import assert from 'node:assert/strict';
import {chargingPolicy,optimizePathCharging} from './lib/charging-optimization.mjs';
import {planChargingRoadTrip} from './lib/charging-route.mjs';
const input={origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:false,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,externalMapsConsent:true};
test('planner rejects personal tariff inputs',async()=>{
 await assert.rejects(planChargingRoadTrip({...input,personalTariffs:[]}),/invalid_map_arguments/);
});
test('inconsistent road total and zero-length legs cannot certify a no-charge trip',async()=>{
 let calls=0;await assert.rejects(planChargingRoadTrip(input,{fetcher:async url=>{
  calls++;assert.ok(url.includes('/route/'));
  return Response.json({code:'Ok',routes:[{distance:500000,duration:3600,legs:[{distance:0,duration:3600}],geometry:{coordinates:[[9,45],[10,46]]}}]});
 }}),/map_provider_unavailable/);assert.equal(calls,2);
});
test('cost ranking with unknown power does not claim an ideal time or alter cost feasibility',()=>{
 const p=[{}, {},{operator:'knownA',power_kw:null},{operator:'knownB',power_kw:400}];
 const r=optimizePathCharging({input:{...input,objective:'cost',efficiencyPercent:95,personalTariffs:[{operator:'knownA',eurPerKwh:0.3,fixedFeeEur:0},{operator:'knownB',eurPerKwh:0.4,fixedFeeEur:0}]},
 legs:[111240.9,311622.3,74478.5].map(distance=>({distance,duration:3600})),path:[0,2,3,1],points:p});
 assert.equal(r.feasible,true);assert.equal(r.objective_used,'energy');assert.equal(r.estimated_cost_eur,null);assert.equal(r.theoretical_minimum_charging_minutes,null);assert.ok(r.legs.every(l=>l.reserve_met));
});

import {selectCandidates,computeNationalPlan} from './lib/national-routing.mjs';
import {chooseChargingPath} from './lib/charging-route.mjs';
test('CPU candidate selection stops at the shared deadline and marks the count partial',()=>{
 const r=selectCandidates([{ccs2:true,lat:45.5,lon:9.5}],[[9,45],[10,46]],2000,12,{deadline:Date.now()-1});
 assert.equal(r.truncated,true);assert.equal(r.selected.length,0);
});
test('road-path search cannot consume CPU beyond an exhausted request budget',()=>{
 const r=chooseChargingPath({...input,distances:[[0,100000],[100000,0]],deadline:Date.now()-1});
 assert.equal(r.found,false);assert.equal(r.search_truncated,true);assert.equal(r.budget_exhausted,true);
});
test('expired planning budget preserves road result without starting matrix or station work',async()=>{
 const r=await computeNationalPlan({input,catalog:{countries:[],stations:[]},line:[[9,45],[10,46]],baseResult:{distance_km:200},
 deadline:Date.now()-1,maps:{routing:()=>assert.fail('network after deadline')},route:()=>assert.fail('route after deadline'),choosePath:()=>assert.fail('CPU after deadline'),estimate:()=>{}});
 assert.equal(r.distance_km,200);assert.equal(r.charging_plan.feasible,null);assert.equal(r.charging_plan.reason,'request_budget_exhausted');
});

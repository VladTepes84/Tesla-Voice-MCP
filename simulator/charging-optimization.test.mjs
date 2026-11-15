import test from 'node:test';import assert from 'node:assert/strict';
import {chargingPolicy,optimizePathCharging} from './lib/charging-optimization.mjs';
import {chooseChargingPath,planChargingRoadTrip} from './lib/charging-route.mjs';
const input={batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,roundTrip:false};
const legs=[111240.9,311622.3,74478.5].map(distance=>({distance,duration:3600}));
const points=[{}, {},{id:'CH*SUI*E5650',operator:'Swiss',power_kw:100},{id:'DE*AUP*E09003*01',operator:'German',power_kw:400}];
const run=(patch={},p=points)=>optimizePathCharging({input:{...input,...patch},legs,path:[0,2,3,1],points:p});
test('Milano–Munich regression eliminates forced 85% charging without lowering reserve',()=>{
 const r=run({consumptionMarginPercent:0});
 assert.equal(r.feasible,true);assert.equal(r.energy_to_battery_kwh,49.5);
 assert.ok(r.stops[1].energy_to_battery_kwh<41);
 assert.equal(r.estimated_arrival_kwh,10.5);
 assert.ok(r.legs.every(l=>l.arrival_kwh>=10.2));
 assert.ok(r.stops.every(s=>s.departure_percent<=85));assert.ok(r.stops[0].departure_percent<85);
 assert.equal(r.estimated_cost_eur,null);assert.equal(r.estimated_purchased_kwh,null);
});
test('default 5% consumption margin and rounded leg energy are explicit',()=>{
 const r=run();assert.equal(r.policy.consumption_margin_percent,5);assert.equal(r.energy_to_battery_kwh,53);
 assert.equal(r.estimated_arrival_kwh,10.5);assert.ok(r.legs.every(l=>l.reserve_met));
 assert.deepEqual(r.stops.map(s=>s.energy_to_battery_kwh),[42.5,10.5]);
});
test('desired final SOC is distinct from per-leg reserve and maximum charging SOC',()=>{
 const r=run({arrivalPercent:30,consumptionMarginPercent:0});
 assert.equal(r.feasible,true);assert.ok(r.estimated_arrival_percent>=30);
 assert.ok(r.legs.every(l=>l.arrival_kwh>=10.2));
 assert.equal(r.policy.maximum_charging_soc_percent,85);
});
test('maximum SOC can make the same path infeasible; optimizer never silently exceeds it',()=>{
 assert.equal(run({chargingTargetPercent:50}).feasible,false);
});
test('power influences allocation without buying excess energy',()=>{
 const fastFirst=points.map(p=>({...p}));fastFirst[2].power_kw=400;fastFirst[3].power_kw=50;
 const a=run({consumptionMarginPercent:0}),b=run({consumptionMarginPercent:0},fastFirst);
 assert.equal(a.energy_to_battery_kwh,b.energy_to_battery_kwh);
 assert.ok(b.stops[0].energy_to_battery_kwh>a.stops[0].energy_to_battery_kwh);
 assert.equal(b.estimated_arrival_kwh,10.5);
});
test('unverified operator prices leave costs unknown and fall back to energy',()=>{
 const r=run({objective:'cost',efficiencyPercent:90,consumptionMarginPercent:0});
 assert.equal(r.objective_used,'energy');assert.equal(r.estimated_cost_eur,null);
 assert.ok(Math.abs(r.estimated_purchased_kwh-55)<1e-8);
 assert.equal(r.stops[0].tariff_source,'unknown');
});
test('Free To X tariff never leaks to an unrelated Swiss or German operator',()=>{
 const r=run({objective:'cost',efficiencyPercent:95});
 assert.equal(r.estimated_cost_eur,null);assert.equal(r.objective_used,'energy');assert.equal(r.objective_limited,true);
 assert.ok(r.stops.every(s=>s.estimated_cost_eur===null));
});
test('unknown station power does not become zero-time charging',()=>{
 const p=points.map(s=>({...s}));p[3].power_kw=null;
 const r=run({objective:'time'},p);assert.equal(r.theoretical_minimum_charging_minutes,null);assert.equal(r.objective_used,'energy');
});
test('invalid policy fails before any provider call',async()=>{
 const base={...input,origin:{lat:45,lon:9},destination:{lat:46,lon:10},externalMapsConsent:true};
 for(const patch of [{arrivalPercent:10},{consumptionMarginPercent:-1},{efficiencyPercent:0},{personalTariffs:[{operator:'x',eurPerKwh:-1,fixedFeeEur:0}]}])
 await assert.rejects(planChargingRoadTrip({...base,...patch},{fetcher:()=>assert.fail('provider called')}));
});
test('reachability search respects desired arrival SOC, not just reserve',()=>{
 const distances=[[0,100000],[100000,0]];
 assert.equal(chooseChargingPath({...input,batteryPercent:50,arrivalPercent:40,distances}).found,false);
 assert.equal(chooseChargingPath({...input,batteryPercent:50,arrivalPercent:15,distances}).found,true);
});

test('round-trip arrival target applies at final origin, not intermediate destination',()=>{
 const distances=[[0,100000,1000000],[100000,0,10000],[100000,10000,0]];
 assert.equal(chooseChargingPath({...input,batteryPercent:50,arrivalPercent:60,roundTrip:true,distances}).found,true);
});
test('missing final road leg cannot certify an incomplete itinerary',()=>{
 const r=optimizePathCharging({input,legs:legs.slice(0,2),path:[0,2,3,1],points});assert.equal(r.feasible,false);
});

test('elapsed request budget cannot be reset after a slow initial phase',async()=>{
 const realNow=Date.now;let clock=realNow(),calls=0;
 Date.now=()=>clock;
 try{
 const fetcher=async(url)=>{
  calls++;
  if(url.includes('/table/'))return Response.json({code:'Ok',distances:[[0,200000,50000],[200000,0,150000],[50000,150000,0]]});
  if(calls===1)clock+=26000;
  const distances=calls===1?[200000]:[50000,150000];
  return Response.json({code:'Ok',routes:[{distance:200000,duration:7200,geometry:{coordinates:[[9,45],[9.5,45.5],[10,46]]},legs:distances.map(distance=>({distance,duration:3600}))}]});
 };
 await assert.rejects(planChargingRoadTrip({...input,origin:{lat:45,lon:9},destination:{lat:46,lon:10},externalMapsConsent:true},{
 fetcher,stationCatalog:{countries:['CH'],stations:[{id:'test',lat:45.5,lon:9.5,ccs2:true,power_kw:100}]}}),/map_provider_unavailable/);
 assert.equal(calls,1);
 }finally{Date.now=realNow;}
});

test('station prices remain unknown without a verified price source',()=>{
 const sites=points.map((p,i)=>i>=2?{...p,operator:'Example',ccs2:true}:p);
 const r=run({objective:'cost',efficiencyPercent:100},sites);
 assert.equal(r.estimated_cost_eur,null);assert.equal(r.objective_used,'energy');
 assert.ok(r.stops.every(s=>s.tariff_source==='unknown'&&s.estimated_cost_eur===null));
});

test('battery source timestamps are required for cached/live input and never silently treated as current',()=>{
 for(const batterySource of ['cached','live'])assert.throws(()=>chargingPolicy({...input,batterySource}),/invalid_map_arguments/);
 assert.doesNotThrow(()=>chargingPolicy({...input,batterySource:'cached',batterySampledAt:'2026-11-01T12:00:00Z'}));
 assert.throws(()=>chargingPolicy({...input,batterySource:'cached',batterySampledAt:'bogus'}));
});
test('unknown Supercharger price disables economic ranking rather than becoming free',()=>{
 const p=points.map(s=>({...s}));p[2].operator='Tesla Supercharger';
 const r=run({objective:'cost',efficiencyPercent:95},p);
 assert.equal(r.estimated_cost_eur,null);assert.equal(r.objective_used,'energy');
 assert.equal(r.stops[0].estimated_cost_eur,null);
});

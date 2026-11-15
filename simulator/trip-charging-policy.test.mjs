import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargingRoadTrip, chooseChargingPath } from './lib/charging-route.mjs';
import { computeNationalPlan } from './lib/national-routing.mjs';
import { planSmartTrip } from './lib/smart-trip.mjs';
const origin={lat:45.4642,lon:9.19},destination={lat:46.4285,lon:9.7636};
const input={origin,destination,roundTrip:false,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,efficiencyPercent:95,objective:'cost',preferFreeToXMotorway:false};
for(const [distance,required] of [[24000,false],[24001,true]])test('15% exact arrival boundary with conservative road energy: '+distance,async()=>{
 const request=input;
 const r=await planChargingRoadTrip({...request,externalMapsConsent:true,usableCapacityKwh:100,consumptionKwhPer100Km:100,consumptionMarginPercent:0}, {
  fetcher:async()=>Response.json({code:'Ok',routes:[{distance,duration:1000,legs:[{distance,duration:1000}],geometry:{coordinates:[[9.19,45.4642],[9.7636,46.4285]]}}]}),
  stationCatalog:{stations:[],countries:[]}
 });
 assert.equal(r.direct_energy_assessment.charging_required,required);
 if(!required){assert.equal(r.charging_plan.feasible,true);assert.equal(r.charging_plan.estimated_arrival_percent,15);assert.equal(r.legs[0].reserve_met,true);}
 else{assert.notEqual(r.charging_plan.feasible,true);assert.ok(r.direct_energy_assessment.estimated_arrival_percent<15);}
});
async function alternatives(extra=2000,personal=true){
 const stations=[...(personal?[{id:'ftx',operator:'Free To X',lat:45.5,lon:9.5,ccs2:true,power_kw:150}]:[]),{id:'sc',operator:'Tesla Supercharger',lat:45.51,lon:9.51,ccs2:true,power_kw:250}];
 const points=[origin,destination,...stations];
 const distances=points.map((p,i)=>points.map((q,j)=>i===j?0:i===0&&j===1?250000:i===0&&j>=2?80000:i>=2&&j===1?170000+(p.id==='ftx'?extra:0):1000000));
 return computeNationalPlan({input,catalog:{stations,countries:['IT']},line:[[9.19,45.4642],[9.5,45.5],[9.7636,46.4285]],
  maps:{routing:async()=>({distances})},route:async p=>{const lengths=[80000,170000+(p[1].id==='ftx'?extra:0)];return {distance:lengths.reduce((a,b)=>a+b),duration:7200+extra/20*(p[1].id==='ftx'?1:0),legs:lengths.map(distance=>({distance,duration:3600}))};},
  baseResult:{distance_km:250},choosePath:chooseChargingPath,estimate:()=>({})});
}
test('personal DC estimate applies to non-Tesla stations and keeps reserve',async()=>{
 const r=await alternatives();assert.equal(r.charging_plan.feasible,true);
 assert.equal(r.charging_plan.estimated_cost_eur,null);
 const sc=r.charging_plan.alternatives.find(p=>p.operators.includes('Tesla Supercharger'));
 assert.ok(sc);assert.equal(sc.estimated_cost_eur,null);assert.equal(sc.price_status,'unknown');
 assert.equal(r.charging_plan.economic_comparison.global_cheapest_verified,false);
});
test('personal estimate does not force a 20 km extra detour',async()=>{
 const r=await alternatives(20000);assert.equal(r.charging_plan.stops[0].id,'sc');
 assert.equal(r.charging_plan.estimated_cost_eur,null);
});
test('Supercharger price stays unknown and reserve is still enforced',async()=>{
 const r=await alternatives(0,false);assert.equal(r.charging_plan.feasible,true);
 assert.equal(r.charging_plan.stops[0].id,'sc');assert.equal(r.charging_plan.estimated_cost_eur,null);
 assert.equal(r.charging_plan.stops[0].estimated_cost_eur,null);
 assert.ok(r.legs.every(l=>l.reserve_met&&l.arrival_kwh>=10.2));
});
test('smart orchestrator floors saved reserve at 15 and retains cached SOC provenance and one-request tariff',async()=>{
 const now=()=>Date.parse('2026-11-04T12:00:00Z'),observed_at=new Date(now()-60000).toISOString();
 const r=await planSmartTrip({origin,destination,externalMapsConsent:true,teslaBatteryConsent:true},{subject:'owner',now,
  backend:{preferences:{get:async()=>({preferences:{reservePercent:5}})},withTripReadLease:f=>f(),
   vehicleReadingHistory:async()=>({readings:[{source:'TESLA_CACHED',battery_percent:39,observed_at}]}),battery:()=>assert.fail('unnecessary API read'),location:()=>assert.fail('GPS read')},
  plan:async(args,opts)=>{assert.equal(args.reservePercent,15);assert.equal(args.batterySource,'cached');assert.equal(args.batterySampledAt,observed_at);assert.equal(args.freeToXTariff,undefined);assert.equal(opts.freeToXContract,undefined);
   return {direct_energy_assessment:{charging_required:true,estimated_arrival_percent:3},charging_plan:{feasible:null,stops:[]}};}
 });
 assert.equal(r.status,'charging_unverified');assert.equal(r.charging_recommendation.required,true);
 assert.equal(r.charging_recommendation.action_required,'find_reachable_charging_before_departure');assert.equal(r.navigation.next_destination,null);assert.equal(r.sent_to_vehicle,false);
});

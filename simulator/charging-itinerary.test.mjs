import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeCharging } from './lib/charging-itinerary.mjs';
const tariff = (label, price, flat = 0) => ({label, eurPerKwh:price, fixedFeeEur:flat});
const base = {legs:[{distance_km:100},{distance_km:100}],capacityKwh:50,batteryPercent:50,reservePercent:10,consumptionKwhPer100Km:20,efficiencyPercent:100};
test('optimizer waits for cheaper listed stop and preserves reserve on every leg', () => {
  const r = optimizeCharging({...base, options:[tariff('expensive',1),tariff('cheap',0.1)]});
  assert.equal(r.feasible,true); assert.equal(r.estimated_total_eur,2);
  assert.equal(r.stops.length,1); assert.equal(r.stops[0].before_leg,1);
  assert.equal(r.estimated_arrival_kwh,5); assert.equal(r.tariffs_verified,false);
});
test('flat session fee and charging losses can make origin charging cheaper', () => {
  const r = optimizeCharging({...base,efficiencyPercent:80,options:[tariff('origin',0.2),tariff('flat',0,17.5)]});
  assert.equal(r.estimated_total_eur,5); assert.equal(r.stops[0].before_leg,0);
  assert.equal(r.stops[0].purchased_kwh,25);
});
test('unreachable first leg remains infeasible even if later charging is cheap', () => {
  const r = optimizeCharging({...base,batteryPercent:20,options:[null,tariff('later',0.01)]});
  assert.equal(r.feasible,false); assert.equal(r.blocked_leg,0);
});
test('optimizer rejects missing efficiency, invalid tariffs and mismatched stop lists', () => {
  for (const v of [{...base,options:[]},{...base,options:[null,null],efficiencyPercent:0},{...base,options:[tariff('bad',-1),null]}]) assert.throws(()=>optimizeCharging(v));
});

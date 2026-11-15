import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrip } from './lib/trip-plan.mjs';

const input = {
  distanceKm: 200,
  consumptionKwhPer100Km: 20,
  usableCapacityKwh: 80,
  batteryPercent: 60,
  reservePercent: 25,
  efficiencyPercent: 95,
  first: { label: 'AC', eurPerKwh: 0.35, fixedFeeEur: 0, powerKw: 11 },
  second: { label: 'Forfait', eurPerKwh: 0, fixedFeeEur: 17.5, powerKw: 250 }
};

test('trip plan combines the exact reserve deficit with caller-supplied charging tariffs', () => {
  const result = planTrip(input);
  assert.equal(result.source, 'ESTIMATE');
  assert.equal(result.required_kwh, 40);
  assert.equal(result.estimated_arrival_percent, 10);
  assert.equal(result.meets_reserve, false);
  assert.equal(result.minimum_additional_battery_kwh, 12);
  assert.equal(result.charging_costs.energy_to_battery_kwh, result.minimum_additional_battery_kwh);
  assert.equal(result.charging_costs.first.estimated_eur, 4.42);
  assert.equal(result.charging_costs.first.estimated_minutes_at_constant_power, 68.9);
  assert.equal(result.charging_costs.second.estimated_minutes_at_constant_power, 3);
  assert.equal(result.charging_costs.second.estimated_eur, 17.5);
  assert.equal(result.charging_costs.lower_cost, 'first');
  assert.match(result.note, /Does not identify a route, stops, or charging sites/);
});

test('trip plan does not add a flat session fee when the reserve is already met', () => {
  const result = planTrip({ ...input, batteryPercent: 80, reservePercent: 25 });
  assert.equal(result.meets_reserve, true);
  assert.equal(result.minimum_additional_battery_kwh, 0);
  assert.equal(result.charging_costs, null);
});

test('trip plan rejects missing, invalid and unexpected inputs', () => {
  assert.throws(() => planTrip(null), /invalid_trip_plan_inputs/);
  assert.throws(() => planTrip({ ...input, distanceKm: -1 }), /invalid_energy_inputs/);
  assert.throws(() => planTrip({ ...input, unexpected: true }), /invalid_trip_plan_inputs/);
  assert.throws(() => planTrip({ ...input, first: { ...input.first, private: 'ignored' } }), /invalid_charging_cost_inputs/);
  assert.throws(() => planTrip({ ...input, batteryPercent: 80, first: { label: 'bad', eurPerKwh: Infinity, fixedFeeEur: 0 } }), /invalid_charging_cost_inputs/);
});

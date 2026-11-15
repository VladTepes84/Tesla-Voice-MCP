import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTripEnergy } from './lib/energy-estimate.mjs';

const input = { distanceKm: 200, consumptionKwhPer100Km: 20, usableCapacityKwh: 80, batteryPercent: 70, reservePercent: 25 };
test('estimates energy, arrival and reserve without inventing a charge stop', () => {
  const result = estimateTripEnergy(input);
  assert.equal(result.required_kwh, 40);
  assert.equal(result.estimated_arrival_percent, 20);
  assert.equal(result.minimum_additional_battery_kwh, 4);
  assert.equal(result.meets_reserve, false);
  assert.equal(result.single_full_charge_sufficient, true);
  assert.equal(estimateTripEnergy({ ...input, reservePercent: 20 }).meets_reserve, true);
  assert.equal(estimateTripEnergy({ ...input, distanceKm: 1000 }).single_full_charge_sufficient, false);
});
test('rejects absent, non-finite, wrong-type and impossible inputs', () => {
  for (const change of [{ batteryPercent: NaN }, { reservePercent: -1 }, { usableCapacityKwh: 0 }, { distanceKm: Infinity }, { consumptionKwhPer100Km: '20' }, { batteryPercent: undefined }])
    assert.throws(() => estimateTripEnergy({ ...input, ...change }), /invalid_energy_inputs/);
});

test('exact decimal reserve comparison stays consistent with additional energy', () => {
  const at = { ...input, batteryPercent: 60.3, reservePercent: 10.3 };
  for (const [batteryPercent, meets] of [[60.3, true], [60.30000000000001, true], [60.29999999999999, false]]) {
    const result = estimateTripEnergy({ ...at, batteryPercent });
    assert.equal(result.meets_reserve, meets);
    assert.equal(result.minimum_additional_battery_kwh === 0, meets);
  }
  const exact = estimateTripEnergy(at);
  assert.equal(exact.estimated_arrival_percent, 10.3);
  assert.equal(exact.minimum_additional_battery_kwh, 0);
  const small = estimateTripEnergy({ ...at, batteryPercent: 60.29999999999999 });
  assert.ok(small.minimum_additional_battery_kwh > 0);
  assert.ok(small.minimum_additional_battery_kwh < 1e-12);
});

test('full-charge boundary and minimum positive input stay exact', () => {
  const boundary = { distanceKm: 200, consumptionKwhPer100Km: 20, usableCapacityKwh: 80, batteryPercent: 100, reservePercent: 50 };
  assert.equal(estimateTripEnergy(boundary).single_full_charge_sufficient, true);
  const deficit = estimateTripEnergy({ ...boundary, reservePercent: 50.00000000000001 });
  assert.equal(deficit.single_full_charge_sufficient, false);
  assert.equal(deficit.meets_reserve, false);
  assert.ok(deficit.minimum_additional_battery_kwh > 0);
  const tiny = estimateTripEnergy({ distanceKm: Number.MIN_VALUE, consumptionKwhPer100Km: 1, usableCapacityKwh: 1, batteryPercent: 0, reservePercent: 0 });
  assert.equal(tiny.meets_reserve, false);
  assert.equal(tiny.minimum_additional_battery_kwh, Number.MIN_VALUE);
});

test('positive deficit stays below reserve when the displayed arrival would round to equality', () => {
  const input = { distanceKm: 1e-13, consumptionKwhPer100Km: 1, usableCapacityKwh: 250, batteryPercent: 50, reservePercent: 50 };
  const result = estimateTripEnergy(input);
  assert.equal(result.meets_reserve, false);
  assert.ok(result.minimum_additional_battery_kwh > 0);
  assert.ok(result.estimated_arrival_percent < input.reservePercent);
});

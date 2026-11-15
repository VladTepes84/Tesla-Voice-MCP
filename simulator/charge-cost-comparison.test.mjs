import test from 'node:test';
import assert from 'node:assert/strict';
import { compareChargingCosts } from './lib/charge-cost-comparison.mjs';

const example = { energyToBatteryKwh: 36, efficiencyPercent: 90,
  first: { label: 'Consumo', eurPerKwh: 0.35, fixedFeeEur: 0, powerKw: 11 },
  second: { label: 'Forfait', eurPerKwh: 0, fixedFeeEur: 17.5, powerKw: 250 } };
test('compares energy delivered and purchased for a flat price and a per-kWh price', () => {
  const r = compareChargingCosts(example);
  assert.equal(r.estimated_purchased_kwh, 40);
  assert.equal(r.first.estimated_eur, 14);
  assert.equal(r.second.estimated_eur, 17.5);
  assert.equal(r.lower_cost, 'first');
  assert.equal(r.first.estimated_minutes_at_constant_power, 218.2);
  assert.equal(r.second.estimated_minutes_at_constant_power, 9.6);
  assert.equal(r.source, 'USER_SUPPLIED_TARIFFS');
  assert.equal(compareChargingCosts({ ...example, second: { ...example.second, fixedFeeEur: 14 } }).lower_cost, 'equal');
});
test('rejects missing prices, unbounded values, and unknown properties', () => {
  for (const change of [{ efficiencyPercent: 0 }, { energyToBatteryKwh: -1 },
    { first: { label: 'X', fixedFeeEur: 1 } }, { second: { ...example.second, fixedFeeEur: Infinity } },
    { first: { ...example.first, powerKw: 0 } }, { second: { ...example.second, powerKw: 501 } },
    { first: { ...example.first, other: 1 } }])
    assert.throws(() => compareChargingCosts({ ...example, ...change }), /invalid_charging_cost_inputs/);
});

test('compares rounded euro cents consistently at decimal boundaries', () => {
  const r = compareChargingCosts({ energyToBatteryKwh: 1, efficiencyPercent: 100,
    first: { label: 'A', eurPerKwh: 0.1, fixedFeeEur: 0.2 },
    second: { label: 'B', eurPerKwh: 0.3, fixedFeeEur: 0 } });
  assert.equal(r.first.estimated_eur, 0.3);
  assert.equal(r.second.estimated_eur, 0.3);
  assert.equal(r.lower_cost, 'equal');
  const half = compareChargingCosts({ energyToBatteryKwh: 1, efficiencyPercent: 100,
    first: { label: 'A', eurPerKwh: 1.005, fixedFeeEur: 0 },
    second: { label: 'B', eurPerKwh: 1.01, fixedFeeEur: 0 } });
  assert.equal(half.first.estimated_eur, 1.01);
  assert.equal(half.lower_cost, 'equal');
});

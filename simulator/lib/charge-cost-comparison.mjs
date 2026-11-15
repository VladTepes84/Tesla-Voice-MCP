export const chargingTariffSchema = { type: 'object', properties: {
  label: { type: 'string', minLength: 1, maxLength: 80 },
  eurPerKwh: { type: 'number', minimum: 0, maximum: 100 },
  fixedFeeEur: { type: 'number', minimum: 0, maximum: 10000 },
  powerKw: { type: 'number', minimum: 0.1, maximum: 500 }
}, required: ['label', 'eurPerKwh', 'fixedFeeEur'], additionalProperties: false };
export const chargingCostTool = {
  name: 'compare_charging_costs',
  description: 'Compares two prices supplied for this request and an explicit charging efficiency. Does not use saved tariffs, verify prices or availability, or contact Tesla.',
  inputSchema: { type: 'object', properties: {
    energyToBatteryKwh: { type: 'number', minimum: 0, maximum: 250 },
    efficiencyPercent: { type: 'number', minimum: 1, maximum: 100 }, first: chargingTariffSchema, second: chargingTariffSchema,
  }, required:['energyToBatteryKwh','efficiencyPercent','first','second'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: ['battery:read'] }]
};

// Compare only caller-supplied prices; this does not fetch tariffs or vehicle data.
export function compareChargingCosts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['energyToBatteryKwh','efficiencyPercent','first','second'].includes(k))) throw Error('invalid_charging_cost_inputs');
  const { energyToBatteryKwh, efficiencyPercent, first, second }=input;
  const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const validPlan = p => p && typeof p === 'object' && !Array.isArray(p) &&
    typeof p.label === 'string' && p.label.trim().length > 0 && p.label.length <= 80 &&
    finite(p.eurPerKwh, 0, 100) && finite(p.fixedFeeEur, 0, 10000) &&
    (p.powerKw === undefined || finite(p.powerKw, 0.1, 500)) &&
    Object.keys(p).every(k => ['label', 'eurPerKwh', 'fixedFeeEur', 'powerKw'].includes(k));
  if (!finite(energyToBatteryKwh, 0, 250) || !finite(efficiencyPercent, 1, 100) || !validPlan(first) || !validPlan(second))
    throw Error('invalid_charging_cost_inputs');
  const purchasedKwh = energyToBatteryKwh * 100 / efficiencyPercent;
  // Compute and compare the same euro-cent amounts, rounding half up only once.
  const decimal = value => {
    const [, whole, fraction = '', exponent = '0'] = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  };
  const values = [energyToBatteryKwh, efficiencyPercent, first.eurPerKwh, first.fixedFeeEur, second.eurPerKwh, second.fixedFeeEur].map(decimal);
  const scale = Math.max(0, ...values.map(v => v.scale));
  const [energy, efficiency, priceA, fixedA, priceB, fixedB] = values.map(v => v.digits * 10n ** BigInt(scale - v.scale));
  const denominator = efficiency * 10n ** BigInt(scale);
  const cents = (price, fixed) => {
    const numerator = energy * 100n * price + fixed * efficiency;
    return (numerator * 200n + denominator) / (2n * denominator);
  };
  const aCents = cents(priceA, fixedA), bCents = cents(priceB, fixedB);
  const result = (p, total) => ({ label: p.label, eur_per_kwh: p.eurPerKwh, fixed_fee_eur: p.fixedFeeEur,
    estimated_eur: Number(total) / 100,
    ...(p.powerKw === undefined ? {} : { nominal_power_kw: p.powerKw,
      estimated_minutes_at_constant_power: Math.round(purchasedKwh / p.powerKw * 600) / 10 }) });
  const a = result(first, aCents), b = result(second, bCents);
  return { source: 'USER_SUPPLIED_TARIFFS', currency: 'EUR', energy_to_battery_kwh: energyToBatteryKwh,
    assumed_efficiency_percent: efficiencyPercent, estimated_purchased_kwh: purchasedKwh,
    first: a, second: b, lower_cost: aCents < bCents ? 'first' : aCents > bCents ? 'second' : 'equal',
    note: 'Estimate based on caller-supplied prices and efficiency; prices and availability are not verified. Totals are rounded to cents and exclude unspecified fees and provider rounding. If power is supplied, duration assumes constant power and does not model the Tesla charging curve.' };
}

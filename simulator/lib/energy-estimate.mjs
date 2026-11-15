export const energyEstimateTool = {
  name: 'estimate_trip_energy',
  description: 'Estimates required energy and arrival battery from the supplied distance, consumption, usable capacity, starting battery, and reserve. Does not read Tesla or calculate a route. Ask for missing inputs and always label the result as an estimate.',
  inputSchema: { type: 'object', properties: {
    distanceKm: { type: 'number', minimum: 0, maximum: 10000 },
    consumptionKwhPer100Km: { type: 'number', minimum: 1, maximum: 100 },
    usableCapacityKwh: { type: 'number', minimum: 1, maximum: 250 },
    batteryPercent: { type: 'number', minimum: 0, maximum: 100 },
    reservePercent: { type: 'number', minimum: 0, maximum: 100 }
  }, required: ['distanceKm', 'consumptionKwhPer100Km', 'usableCapacityKwh', 'batteryPercent', 'reservePercent'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: ['battery:read'] }]
};

// All inputs are supplied by the caller; no vehicle or route data is fetched.
export function estimateTripEnergy({ distanceKm, consumptionKwhPer100Km, usableCapacityKwh, batteryPercent, reservePercent }) {
  const valid = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  if (!valid(distanceKm, 0, 10000) || !valid(consumptionKwhPer100Km, 1, 100) ||
      !valid(usableCapacityKwh, 1, 250) || !valid(batteryPercent, 0, 100) || !valid(reservePercent, 0, 100)) throw Error('invalid_energy_inputs');
  // Compare decimal inputs exactly: no tolerance may turn a real deficit into zero.
  // Interpret each input by its canonical JavaScript decimal representation.
  const decimal = value => {
    const [, whole, fraction = '', exponent = '0'] = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  };
  const inputs = [distanceKm, consumptionKwhPer100Km, usableCapacityKwh, batteryPercent, reservePercent].map(decimal);
  const scale = Math.max(0, ...inputs.map(value => value.scale));
  const [distance, consumption, capacity, battery, reserve] = inputs.map(value => value.digits * 10n ** BigInt(scale - value.scale));
  const energyNumerator = distance * consumption;
  const deficitNumerator = energyNumerator + capacity * (reserve - battery);
  const energyValue = numerator => Number(`${numerator}e-${2 * scale + 2}`);
  const requiredKwh = energyValue(energyNumerator);
  // Preserve a positive result even if a valid subnormal deficit underflows Number.
  const deficitKwh = deficitNumerator > 0n ? energyValue(deficitNumerator) || Number.MIN_VALUE : 0;
  const arrivalNumerator = battery * capacity - energyNumerator;
  const rawArrivalPercent = Number(`${arrivalNumerator}e-${2 * scale}`) / usableCapacityKwh;
  // If converting to Number would round a real deficit back up to the reserve,
  // report the immediately lower representable percent. This is conservative
  // and keeps the displayed estimate consistent with the exact reserve check.
  const nextDown = value => {
    if (value === 0) return -Number.MIN_VALUE;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    view.setBigUint64(0, bits + (value > 0 ? -1n : 1n));
    return view.getFloat64(0);
  };
  const arrivalPercent = deficitNumerator > 0n && rawArrivalPercent >= reservePercent
    ? nextDown(reservePercent) : rawArrivalPercent;
  return { source: 'ESTIMATE', model: 'constant_consumption', inputs: { distanceKm, consumptionKwhPer100Km, usableCapacityKwh, batteryPercent, reservePercent },
    required_kwh: requiredKwh, estimated_arrival_percent: arrivalPercent,
    meets_reserve: deficitNumerator <= 0n, minimum_additional_battery_kwh: deficitKwh,
    single_full_charge_sufficient: energyNumerator <= capacity * (100n * 10n ** BigInt(scale) - reserve),
    note: 'Theoretical estimate only: does not read Tesla or calculate a route; consumption, capacity, and battery values are supplied by the caller. A positive deficit remains visible even when hidden by numeric precision. A negative percentage indicates insufficient energy. Excludes weather, traffic, losses, and stops.' };
}

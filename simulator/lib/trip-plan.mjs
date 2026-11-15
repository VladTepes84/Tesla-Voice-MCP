import { estimateTripEnergy } from './energy-estimate.mjs';
import { compareChargingCosts, chargingCostTool, chargingTariffSchema } from './charge-cost-comparison.mjs';

export const tripPlanTool = {
  name: 'plan_trip',
  description: 'Combines an energy estimate with a comparison of two supplied or verified tariffs. If nominal power is provided, also reports a theoretical constant-power duration; this does not model the Tesla charging curve. Does not calculate a route, choose stops or charging sites, verify prices, or contact Tesla. Do not assume an unconfirmed battery capacity.',
  inputSchema: { type: 'object', properties: {
    distanceKm: { type: 'number', minimum: 0, maximum: 10000 },
    consumptionKwhPer100Km: { type: 'number', minimum: 1, maximum: 100 },
    usableCapacityKwh: { type: 'number', minimum: 1, maximum: 250 },
    batteryPercent: { type: 'number', minimum: 0, maximum: 100 },
    reservePercent: { type: 'number', minimum: 0, maximum: 100 },
    efficiencyPercent: { type: 'number', minimum: 1, maximum: 100 },
    first: chargingTariffSchema,
    second: chargingTariffSchema
  }, required: ['distanceKm', 'consumptionKwhPer100Km', 'usableCapacityKwh', 'batteryPercent', 'reservePercent', 'efficiencyPercent', 'first', 'second'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: chargingCostTool.securitySchemes
};

const inputKeys = new Set(['distanceKm', 'consumptionKwhPer100Km', 'usableCapacityKwh', 'batteryPercent', 'reservePercent', 'efficiencyPercent', 'first', 'second']);

// The plan combines caller-supplied inputs only; it never reads Tesla or a route service.
export function planTrip(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !inputKeys.has(key)))
    throw Error('invalid_trip_plan_inputs');
  const trip = estimateTripEnergy(input);
  const comparison = compareChargingCosts({
    energyToBatteryKwh: trip.minimum_additional_battery_kwh,
    efficiencyPercent: input.efficiencyPercent,
    first: input.first,
    second: input.second
  });
  const charging_costs = trip.meets_reserve ? null : comparison;
  return {
    source: 'ESTIMATE',
    ...trip,
    charging_costs,
    note: trip.meets_reserve
      ?'The estimated reserve is met; the plan adds no charging session or fixed fee.'
      :'Estimated cost comparison for the minimum energy needed to reach the reserve. Does not identify a route, stops, or charging sites.'
  };
}

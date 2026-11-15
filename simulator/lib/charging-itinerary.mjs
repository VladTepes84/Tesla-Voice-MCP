import { compareChargingCosts } from './charge-cost-comparison.mjs';

// Optimize only the explicitly listed stops on the routed itinerary. A 0.5 kWh
// grid rounds consumption/reserve up and starting energy down, conservatively.
export function optimizeCharging({ legs, options, capacityKwh, batteryPercent, reservePercent, consumptionKwhPer100Km, efficiencyPercent }) {
  if (!Array.isArray(legs) || !legs.length || legs.length > 10 || !Array.isArray(options) || options.length !== legs.length) throw Error('invalid_charging_itinerary');
  const valid = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
  if (!valid(capacityKwh, 1, 250) || !valid(batteryPercent, 0, 100) || !valid(reservePercent, 0, 100) || !valid(consumptionKwhPer100Km, 1, 100) || !valid(efficiencyPercent, 1, 100) || legs.some(l => !valid(l.distance_km, 0, 10000))) throw Error('invalid_charging_itinerary');
  for (const tariff of options) if (tariff !== null) compareChargingCosts({ energyToBatteryKwh: 0, efficiencyPercent, first: tariff, second: tariff });
  const capacity = Math.floor(capacityKwh * 2), reserve = Math.ceil(capacityKwh * reservePercent / 50);
  let states = new Map([[Math.floor(capacityKwh * batteryPercent / 50), { cost: 0, stops: [] }]]);
  for (let leg = 0; leg < legs.length; leg++) {
    const used = Math.ceil(legs[leg].distance_km * consumptionKwhPer100Km / 50);
    const next = new Map(), tariff = options[leg];
    for (const [energy, state] of states) {
      const maximum = tariff === null ? energy : capacity;
      for (let departure = energy; departure <= maximum; departure++) {
        const arrival = departure - used;
        if (arrival < reserve) continue;
        const added = (departure - energy) / 2;
        const purchased = added * 100 / efficiencyPercent;
        const cost = state.cost + (added > 0 ? tariff.fixedFeeEur + purchased * tariff.eurPerKwh : 0);
        if (!next.has(arrival) || cost < next.get(arrival).cost) next.set(arrival, {
          cost, stops: added > 0 ? [...state.stops, { before_leg: leg, label: tariff.label, energy_to_battery_kwh: added, purchased_kwh: purchased, tariff_source: 'USER_SUPPLIED', estimated_eur: Math.round((tariff.fixedFeeEur + purchased * tariff.eurPerKwh) * 100) / 100 }] : state.stops
        });
      }
    }
    states = next;
    if (!states.size) return { feasible: false, blocked_leg: leg, reason: 'insufficient_energy_or_listed_charging_options', model: 'conservative_0.5_kwh_grid', sent_to_vehicle: false };
  }
  const [arrival, best] = [...states].sort((a, b) => a[1].cost - b[1].cost || b[0] - a[0])[0];
  return { feasible: true, estimated_total_eur: Math.round(best.cost * 100) / 100, estimated_arrival_kwh: arrival / 2, stops: best.stops, model: 'conservative_0.5_kwh_grid', optimization_scope: 'listed_stops_only', tariffs_verified: false, availability_verified: false, sent_to_vehicle: false };
}

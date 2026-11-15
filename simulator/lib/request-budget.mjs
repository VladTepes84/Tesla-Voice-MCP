// One shared, Redis-backed UTC-day ceiling for every Tesla HTTP request.
// Reserve the complete multi-request flow before starting any outbound call.
const reservationCounts = new WeakMap();

// Keep scanning historical slots so a lower cap never hides prior usage.
const MAX_TESLA_DAILY_REQUEST_LIMIT = 50;
const HARD_TESLA_DAILY_REQUEST_LIMIT = 50;

// Every Tesla HTTP request shares this configured UTC-day ceiling. The portal's
// separate monthly billing limit remains an independent euro-denominated cap.
export function effectiveTeslaRequestLimit(env, timestamp) {
  if (env?.VERCEL_ENV === 'production' || env?.TESLA_DAILY_READ_LIMIT === 'unlimited')
    return Number.isFinite(timestamp) ? Infinity : NaN;
  const baseline = Number(env?.TESLA_DAILY_READ_LIMIT);
  if (!Number.isInteger(baseline) || baseline < 1 ||
      baseline > MAX_TESLA_DAILY_REQUEST_LIMIT || !Number.isFinite(timestamp)) return NaN;
  return Math.min(baseline, HARD_TESLA_DAILY_REQUEST_LIMIT);
}

// Observational only: never reserves, resets or refunds any slot.
export async function readTeslaRequestBudget({ store, env, now = Date.now } = {}) {
  try {
    const timestamp = now();
    const limit = effectiveTeslaRequestLimit(env, timestamp);
    if (!Number.isInteger(limit) && limit !== Infinity) return { available: false, reason: 'configuration' };
    if (typeof store?.get !== 'function') throw Error('store');
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const values = await Promise.all(Array.from({ length: MAX_TESLA_DAILY_REQUEST_LIMIT }, (_, slot) =>
      store.get('read-budget:' + day + ':' + slot)));
    if (values.some(value => value !== null && value !== '1')) throw Error('store');
    const extraRaw = await store.get('read-budget-extra:' + day);
    if (extraRaw !== null && (typeof extraRaw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(extraRaw) || !Number.isSafeInteger(Number(extraRaw)))) throw Error('store');
    const reserved = values.filter(value => value === '1').length + Number(extraRaw ?? 0);
    if (!Number.isSafeInteger(reserved)) throw Error('store');
    if (limit === Infinity) return { available:true, day_utc:day, limit:null, unlimited:true, reserved, remaining:null, resets_at:null, reservation:false };
    return { available: true, day_utc: day, limit, reserved,
      remaining: Math.max(0, limit - reserved),
      resets_at: new Date(Date.parse(day + 'T00:00:00.000Z') + 86400000).toISOString(),
      reservation: false };
  } catch {
    return { available: false, reason: 'storage_or_clock' };
  }
}

export async function reserveTeslaRequests({ store, env, now = Date.now, count = 1 } = {}) {
  const timestamp = now();
  const limit = effectiveTeslaRequestLimit(env, timestamp);
  if ((!Number.isInteger(limit) && limit !== Infinity) ||
      !Number.isInteger(count) || count < 1 || count > Math.min(limit, 100)) {
    throw Error('configuration');
  }
  if (!store || typeof store.once !== 'function' || typeof store.get !== 'function') throw Error('budget_store_unavailable');

  let day;
  try { day = new Date(timestamp).toISOString().slice(0, 10); }
  catch { throw Error('configuration'); }

  if (typeof store.reserveTeslaBudget === 'function') {
    let reserved;
    try { reserved = await store.reserveTeslaBudget(day, limit, count); }
    catch { throw Error('budget_store_unavailable'); }
    if (!reserved || new Date(now()).toISOString().slice(0, 10) !== day) throw Error('budget');
    const reservation = Object.freeze({});
    reservationCounts.set(reservation, count);
    return reservation;
  }

  if (limit === Infinity) throw Error('budget_store_unavailable');
  let extra;
  try { const raw = await store.get('read-budget-extra:' + day); if (raw !== null && (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw Error('store'); extra=Number(raw??0); } catch { throw Error('budget_store_unavailable'); }
  // Legacy reservations may be sparse: slots 10..49 consume capacity too.
  // New workers only allocate low slots. Reducing their fixed allocation window
  // by the high-slot count preserves SET NX concurrency protection.
  let historical;
  try {
    historical = await Promise.all(Array.from({ length: MAX_TESLA_DAILY_REQUEST_LIMIT - limit },
      (_, slot) => store.get(`read-budget:${day}:${slot + limit}`)));
    if (historical.some(value => value !== null && value !== '1')) throw Error('store');
  } catch { throw Error('budget_store_unavailable'); }
  const allocationLimit = limit - historical.filter(value => value === '1').length - extra;
  if (allocationLimit < count) throw Error('budget');

  // Each SET NX is atomic in the shared store. A partial reservation is kept
  // if quota runs out midway, but callers must not start the Tesla flow then.
  for (let request = 0; request < count; request++) {
    let reserved = false;
    for (let slot = 0; slot < allocationLimit; slot++) {
      const currentTime = now();
      if (slot >= effectiveTeslaRequestLimit(env, currentTime) ||
          new Date(currentTime).toISOString().slice(0, 10) !== day) throw Error('budget');
      let created;
      try { created = await store.once(`read-budget:${day}:${slot}`, 172800); }
      catch { throw Error('budget_store_unavailable'); }
      if (created) {
        reserved = true;
        break;
      }
    }
    if (!reserved) throw Error('budget');
  }
  const reservation = Object.freeze({});
  reservationCounts.set(reservation, count);
  return reservation;
}

// Multi-request helpers require a reservation issued by this module. This
// prevents an arbitrary boolean from bypassing the shared quota check.
export function consumeTeslaRequestReservation(reservation, count) {
  if (!reservation || reservationCounts.get(reservation) !== count) return false;
  reservationCounts.delete(reservation);
  return true;
}

import { createHmac } from 'node:crypto';
import { seal, unseal } from './security.mjs';

const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLocaleLowerCase('it').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

// Persistent cache for user-requested public geocoding only. Query keys are
// keyed HMACs and values are encrypted because a query can contain a home or
// other private address. Public geocoding results remain attributed at source.
export function destinationSearchCache({ store, config, now = Date.now } = {}) {
  if (!store?.get || !store?.put || !config?.key || !config?.issuer) throw Error('configuration');
  const pending = new Map();
  const placeIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
  const keyFor = (subject, query) => {
    if (typeof subject !== 'string' || !subject || typeof query !== 'string' || !normalize(query)) throw Error('invalid_map_arguments');
    const digest = createHmac('sha256', config.key).update(config.issuer + '\n' + subject + '\n' + normalize(query)).digest('base64url');
    return 'destination-search:' + digest;
  };
  const placeProofKey = (subject, placeId) => {
    if (typeof subject !== 'string' || !subject || typeof placeId !== 'string' || !placeIdPattern.test(placeId)) throw Error('invalid_map_arguments');
    const digest = createHmac('sha256', config.key)
      .update(config.issuer + '\n' + subject + '\ngoogle-place-id-proof-v1\n' + placeId).digest('base64url');
    return 'google-place-id-proof:' + digest;
  };
  return {
    async attestGooglePlaceIds(subject, placeIds, ttlSeconds = 6 * 60 * 60) {
      if (!Array.isArray(placeIds) || placeIds.length > 20 ||
          !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 6 * 60 * 60 ||
          placeIds.some(id => typeof id !== 'string' || !placeIdPattern.test(id))) throw Error('invalid_map_arguments');
      const ids = [...new Set(placeIds)];
      for (const placeId of ids) {
        const key = placeProofKey(subject, placeId);
        const value = seal({ version: 1, source: 'GOOGLE_PLACES_API_NEW', subject, placeId,
          expires_at: now() + ttlSeconds * 1000 }, config.key, key);
        await store.put(key, value, ttlSeconds);
      }
      return ids.length;
    },
    async verifyGooglePlaceIds(subject, placeIds) {
      if (typeof subject !== 'string' || !subject || !Array.isArray(placeIds) || placeIds.length > 16 ||
          placeIds.some(id => typeof id !== 'string' || !placeIdPattern.test(id))) throw Error('invalid_map_arguments');
      const verified = [];
      for (const placeId of new Set(placeIds)) {
        const key = placeProofKey(subject, placeId);
        const raw = await store.get(key);
        if (!raw) continue;
        let record;
        try { record = unseal(raw, config.key, key); } catch { continue; }
        if (record?.version === 1 && record.source === 'GOOGLE_PLACES_API_NEW' && record.subject === subject &&
            record.placeId === placeId && Number.isFinite(record.expires_at) && record.expires_at > now()) {
          verified.push(placeId);
        }
      }
      return verified;
    },
    async reserveGooglePlacesRequest() {
      if (typeof store.reserveGooglePlacesRequest !== 'function') throw Error('store');
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw Error('store');
      const day = new Date(timestamp).toISOString().slice(0, 10);
      return store.reserveGooglePlacesRequest(day);
    },
    async resolve(subject, query, load) {
      if (typeof load !== 'function') throw Error('invalid_map_arguments');
      const key = keyFor(subject, query);
      if (pending.has(key)) return { ...(await pending.get(key)), cache_hit: false, request_deduplicated: true };
      const task = (async () => {
        try {
          const raw = await store.get(key);
          if (raw) {
            const cached = unseal(raw, config.key, key);
            if (cached?.version === 1 && Number.isFinite(cached.expires_at) && cached.expires_at > now() &&
                cached.subject === subject && cached.query_key === createHmac('sha256', config.key).update(normalize(query)).digest('base64url') &&
                cached.result && typeof cached.result.source === 'string' && Array.isArray(cached.result.candidates)) {
              return { result: structuredClone(cached.result), cache_hit: true, cache_age_seconds: Math.max(0, Math.floor((now() - cached.saved_at) / 1000)) };
            }
          }
        } catch { /* Cache failure never blocks an explicitly requested lookup. */ }

        const result = await load();
        if (result && typeof result.source === 'string' && Array.isArray(result.candidates) &&
            result.source !== 'PRIVATE_ACCOUNT_ALIAS_REQUIRED' && !result.reason?.includes('unavailable') &&
            (result.candidates.length > 0 || !['photon_unavailable','provider_unavailable','providers_unavailable','rate_limiter_unavailable'].includes(result.fallback_status))) {
          const positive = result.candidates.length > 0;
          const ttl = positive ? 6 * 60 * 60 : 5 * 60;
          const saved_at = now();
          const value = seal({ version: 1, subject, query_key: createHmac('sha256', config.key).update(normalize(query)).digest('base64url'),
            saved_at, expires_at: saved_at + ttl * 1000, result }, config.key, key);
          try { await store.put(key, value, ttl); } catch { /* No unencrypted or in-memory production fallback. */ }
        }
        return { result, cache_hit: false, cache_age_seconds: null };
      })();
      pending.set(key, task);
      try { return await task; } finally { pending.delete(key); }
    }
  };
}

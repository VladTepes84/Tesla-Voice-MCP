import { https, jsonFetch, random } from './security.mjs';
// Upstash-compatible Redis REST. No filesystem/in-memory production fallback.
export const GOOGLE_PLACES_DAILY_REQUEST_LIMIT = 20;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function persistentStore(env, fetcher = fetch) {
  const endpoint = https(env.TOKEN_STORE_REST_URL).href;
  if (!env.TOKEN_STORE_REST_TOKEN) throw Error('configuration');
  async function command(...args) {
    const data = await jsonFetch(fetcher, endpoint, { method: 'POST', headers: { authorization: `Bearer ${env.TOKEN_STORE_REST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
    if (data.error) throw Error('store');
    return data.result;
  }
  const prefix = 'tesla-voice:v1:';
  return {
    // Bounded read-only page: real Redis SCAN/GET, no KEYS or deletion.
    async commandStatePage(cursor = '0', timeoutMs = 1500) {
      if (typeof cursor !== 'string' || !/^\d{1,20}$/.test(cursor)) throw Error('invalid_arguments');
      const script = "local p=redis.call('SCAN',ARGV[1],'MATCH',ARGV[2],'COUNT',64); local rows={}; for i=1,math.min(#p[2],64) do local v=redis.call('GET',p[2][i]); if v then table.insert(rows,{p[2][i],v}) end end; return {p[1],rows,#p[2]>64 and 1 or 0}";
      const data = await jsonFetch(fetcher, endpoint, { method:'POST', headers:{authorization:`Bearer ${env.TOKEN_STORE_REST_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify(['EVAL',script,0,cursor,prefix+'direct-state:*']) }, {}, timeoutMs);
      if (data.error || !Array.isArray(data.result) || !Array.isArray(data.result[1])) throw Error('store');
      return { cursor:String(data.result[0]), records:data.result[1], truncated:data.result[2] === 1 };
    },
    async reserveTeslaBudget(day, limit, count) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (limit !== Infinity && (!Number.isInteger(limit) || limit < 1 || limit > 50)) || !Number.isInteger(count) || count < 1 || count > Math.min(limit,100)) throw Error('configuration');
      const keys = Array.from({ length: 50 }, (_, i) => prefix + `read-budget:${day}:${i}`);
      // Count and allocate in one Redis operation, including sparse legacy slots.
      const script = "local raw=redis.call('GET',ARGV[3]); local extra=tonumber(raw or '0'); if not extra or extra<0 or extra~=math.floor(extra) or extra>9007199254740891 then return -1 end; local used=extra; local free={}; for i=1,#KEYS do local v=redis.call('GET',KEYS[i]); if v then if v~='1' then return -1 end; used=used+1 elseif ARGV[1]~='unlimited' and i<=tonumber(ARGV[1]) then table.insert(free,KEYS[i]) end end; local n=tonumber(ARGV[2]); if ARGV[1]=='unlimited' then redis.call('INCRBY',ARGV[3],n); redis.call('EXPIRE',ARGV[3],172800); return 1 end; if used+n>tonumber(ARGV[1]) or #free<n then return 0 end; for i=1,n do redis.call('SET',free[i],'1','EX',172800) end; return 1";
      const result = await command('EVAL', script, keys.length, ...keys, limit === Infinity ? 'unlimited' : limit, count, prefix + 'read-budget-extra:' + day);
      if (result !== 0 && result !== 1) throw Error('store');
      return result === 1;
    },
    // Global hard cap for Google Places Text Search calls. This counter is
    // independent from every Tesla budget and fails closed if its value or
    // Redis response is malformed.
    async reserveGooglePlacesRequest(day) {
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('configuration');
      const parsedDay = new Date(`${day}T00:00:00.000Z`);
      if (!Number.isFinite(parsedDay.valueOf()) || parsedDay.toISOString().slice(0, 10) !== day) throw Error('configuration');
      const key = prefix + `google-places-budget:${day}`;
      const script = "local raw=redis.call('GET',KEYS[1]); local used=tonumber(raw or '0'); local limit=tonumber(ARGV[1]); if not used or used<0 or used~=math.floor(used) or used>limit then return -1 end; if used>=limit then return 0 end; local next=redis.call('INCR',KEYS[1]); if next==1 then redis.call('EXPIRE',KEYS[1],ARGV[2]) end; if next>limit then return -1 end; return 1";
      const result = await command('EVAL', script, 1, key, GOOGLE_PLACES_DAILY_REQUEST_LIMIT, 172800);
      if (result !== 0 && result !== 1) throw Error('store');
      return result === 1;
    },
    get: key => command('GET', prefix + key),
    put: (key, value, ttl) => command('SET', prefix + key, value, 'EX', ttl),
    // Distributed start-rate limiter for the public Nominatim service. Redis
    // server time and a short lease enforce one application-wide request/sec
    // across concurrent Vercel instances. This does not touch Tesla quotas.
    async acquirePublicGeocoderLease({ provider = 'nominatim', intervalMs = 1000, timeoutMs = 9000 } = {}) {
      if (provider !== 'nominatim' || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 10000 ||
          !Number.isInteger(timeoutMs) || timeoutMs < intervalMs || timeoutMs > 30000) throw Error('invalid_arguments');
      const lock = prefix + `public-geocoder:${provider}:lock`;
      const next = prefix + `public-geocoder:${provider}:next`;
      const owner = random(), started = Date.now();
      const acquire = "if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[3])~='OK' then return -1 end; local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); local next=tonumber(redis.call('GET',KEYS[2]) or '0'); if now<next then redis.call('DEL',KEYS[1]); return next-now end; redis.call('SET',KEYS[2],now+tonumber(ARGV[2]),'PX',tonumber(ARGV[2])+60000); return 0";
      while (Date.now() - started < timeoutMs) {
        const raw = await command('EVAL', acquire, 2, lock, next, owner, intervalMs, 8000);
        if (raw === null || raw === undefined || !Number.isFinite(Number(raw)) || Number(raw) < -1) throw Error('store');
        const wait = Number(raw);
        if (wait === 0) return { release: () => command('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lock, owner) };
        await pause(wait > 0 ? Math.min(wait, 250) : 100);
      }
      throw Error('map_provider_rate_limiter_busy');
    },
    // Persistent, atomic key creation: refuses to overwrite an existing Tesla
    // identity and does not silently expire it (unlike short-lived OAuth data).
    putOncePermanent: async (key, value) => (await command('SET', prefix + key, value, 'NX')) === 'OK',
    take: key => command('GETDEL', prefix + key),
    persist: key => command('PERSIST', prefix + key),
    once: async (key, ttl) => (await command('SET', prefix + key, '1', 'NX', 'EX', ttl)) === 'OK',
    async lock(key) {
      const owner = random(), lock = prefix + 'lock:' + key;
      if (await command('SET', lock, owner, 'NX', 'EX', 60) !== 'OK') throw Error('busy');
      return {
        // Fence dispatch and create its scoped permanent guard in one operation.
        saveWithGuard: async (value, pendingKey, pendingValue, ttlSeconds, recordKey = key) => {
          if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)) throw Error('configuration');
          const script = ttlSeconds === undefined
            ? "-- command_guard_claim\nif redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end; if redis.call('EXISTS',KEYS[3])==1 then return 0 end; redis.call('SET',KEYS[3],ARGV[3]); redis.call('SET',KEYS[2],ARGV[2]); return 1"
            : "-- command_guard_claim\nif redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end; if redis.call('EXISTS',KEYS[3])==1 then return 0 end; redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4]); redis.call('SET',KEYS[2],ARGV[2]); return 1";
          const args = ttlSeconds === undefined
            ? [3, lock, prefix + recordKey, prefix + pendingKey, owner, value, pendingValue]
            : [3, lock, prefix + recordKey, prefix + pendingKey, owner, value, pendingValue, ttlSeconds];
          const saved = await command('EVAL', script, ...args);
          if (saved === -1) throw Error('busy');
          if (saved !== 0 && saved !== 1) throw Error('store');
          return saved === 1;
        },
        clearGuard: async (pendingKey, pendingValue) => command('EVAL', "-- command_guard_clear\nif redis.call('GET',KEYS[1])==ARGV[1] and redis.call('GET',KEYS[2])==ARGV[2] then return redis.call('DEL',KEYS[2]) else return 0 end", 2, lock, prefix + pendingKey, owner, pendingValue),
        // Compare lock ownership and save atomically: expired workers cannot overwrite rotation.
        save: async (value, ttl) => {
          const ok = await command('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end", 2, lock, prefix + key, owner, value, ttl);
          if (ok !== 1) throw Error('store');
        },
        savePermanent: async (value, ttlSeconds, recordKey = key) => {
          if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)) throw Error('configuration');
          const script = ttlSeconds === undefined
            ? "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2]); return 1 else return 0 end"
            : "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end";
          const args = ttlSeconds === undefined ? [2, lock, prefix + recordKey, owner, value] : [2, lock, prefix + recordKey, owner, value, ttlSeconds];
          const saved = await command('EVAL', script, ...args);
          if (saved !== 1) throw Error('busy');
        },
        release: () => command('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lock, owner)
      };
    }
  };
}

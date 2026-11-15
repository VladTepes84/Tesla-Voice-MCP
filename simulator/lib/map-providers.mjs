import { deadlineFetcher, withinDeadline } from './request-deadline.mjs';
import { jsonFetch } from './security.mjs';

// Fixed public origins only. No user URLs, credentials, redirects or Tesla calls.
// Small private on-demand use; no background polling. Cache is bounded and
// process-local, intentionally independent of Tesla's Redis and request quota.
const pools = new WeakMap();
const providers = {
  routing: [
    ['osrm', 'https://router.project-osrm.org'],
    ['fossgis', 'https://routing.openstreetmap.de/routed-car']
  ],
  charging: [
    ['overpass_europe', 'https://ovp.dresel.systems/api/interpreter'],
    ['private_coffee', 'https://overpass.private.coffee/api/interpreter']
  ]
};
export function routePreferenceExclusions(preferences = {}) {
  if (!preferences || Object.getPrototypeOf(preferences) !== Object.prototype ||
      Object.keys(preferences).some(key => !['avoidTolls','avoidHighways','avoidMotorways','preferredRoads'].includes(key)) ||
      ['avoidTolls','avoidHighways','avoidMotorways'].some(key => preferences[key] !== undefined && typeof preferences[key] !== 'boolean') ||
      preferences.preferredRoads !== undefined && (!Array.isArray(preferences.preferredRoads) || preferences.preferredRoads.length > 5 || preferences.preferredRoads.some(name => typeof name !== 'string'))) {
    throw Error('invalid_map_arguments');
  }
  const classes = [];
  if (preferences.avoidHighways === true || preferences.avoidMotorways === true) classes.push('motorway');
  if (preferences.avoidTolls === true) classes.push('toll');
  return classes;
}
function withRouteExclusions(path, classes) {
  if (!classes.length) return path;
  const url = new URL(path, 'https://routing.invalid');
  url.searchParams.set('exclude', classes.join(','));
  return url.pathname + url.search;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function mapClient(fetcher = fetch, { deadline = Date.now() + 25000, routePreferences = {} } = {}) {
  const excludedRouteClasses = routePreferenceExclusions(routePreferences);
  let pool = pools.get(fetcher);
  if (!pool) { pool = { cache: new Map(), pending: new Map(), next: new Map() }; pools.set(fetcher, pool); }
  const diagnostics = [];
  async function request(kind, path, options = {}, validate = () => true) {
    const key = JSON.stringify([kind, path, options.body]);
    const cached = pool.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      diagnostics.push({ stage: kind, provider: cached.provider, outcome: 'cache_hit' });
      return structuredClone(cached.data);
    }
    if (pool.pending.has(key)) return structuredClone(await pool.pending.get(key));
    const run = (async () => {
      for (const [provider, origin] of providers[kind]) {
        const wait = Math.max(0, (pool.next.get(provider) || 0) - Date.now());
        if (Date.now() + wait + 250 >= deadline) {diagnostics.push({stage:kind,outcome:'request_budget_exhausted'});break;}
        // Reserve start slots synchronously, including concurrent requests.
        // With the 6.5-second request deadline, two-second spacing bounds
        // concurrent Europe-instance calls to four per process.
        pool.next.set(provider, Date.now() + wait + (provider==='overpass_europe'?2000:1100));
        if (wait) await sleep(wait);
        const started = Date.now();
        let status = null;
        try {
          const data = await jsonFetch(async (url, init) => {
            const response = await deadlineFetcher(fetcher,deadline)(url, init);
            status = response.status;
            return response;
          }, origin + path, { ...options, headers: {
            'user-agent': 'TeslaVoiceMCP/1.0',
            ...options.headers
          } }, {}, Math.max(1, Math.min(kind === 'charging' ? 6500 : 4500, deadline - Date.now())));
          if (!validate(data)) throw Error('invalid_response');
          diagnostics.push({ stage: kind, provider, outcome: 'ok', elapsed_ms: Date.now() - started });
          // No coordinates, URLs, query contents or upstream bodies in logs.
          console.info('MAP_PROVIDER', JSON.stringify(diagnostics.at(-1)));
          if (pool.cache.size >= 64) pool.cache.delete(pool.cache.keys().next().value);
          pool.cache.set(key, { data: structuredClone(data), provider, expires: Date.now() + (kind === 'charging' ? 900000 : 300000) });
          return data;
        } catch (error) {
          const outcome = status === 429 ? 'rate_limited' : status && status >= 400 ? 'http_error' : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : error?.message === 'invalid_response' ? 'invalid_response' : 'network_error';
          diagnostics.push({ stage: kind, provider, outcome, status, elapsed_ms: Date.now() - started });
          console.info('MAP_PROVIDER', JSON.stringify(diagnostics.at(-1)));
          if (status === 429 || status === 406) {
            pool.next.set(provider, Date.now() + 30000);
            // Respect backpressure; never rotate mirrors to evade a rate limit.
            break;
          }
        }
      }
      throw Error('map_provider_unavailable');
    })();
    pool.pending.set(key, run);
    try { return structuredClone(await run); } finally { pool.pending.delete(key); }
  }
  return {
    diagnostics,
    routing: (path, validate) => request('routing', withRouteExclusions(path, excludedRouteClasses), {}, validate),
    routePreferenceReport: () => {
      const successfulProviders = [...new Set(diagnostics.filter(d => d.stage === 'routing' && ['ok','cache_hit'].includes(d.outcome)).map(d => d.provider))];
      const unsupported = routePreferences.preferredRoads?.length ? ['preferredRoads'] : [];
      return { requested: structuredClone(routePreferences),
        planner_query_applied: excludedRouteClasses.length > 0 && successfulProviders.length > 0,
        excluded_osrm_classes: excludedRouteClasses,
        unsupported_preferences: unsupported,
        successful_router_providers: successfulProviders,
        applied_to_tesla: false,
        real_world_avoidance_verified: false,
        note: 'OSRM profile class exclusions apply only when that hosted profile supports the requested combination; map tagging may be incomplete. Tesla navigation commands do not carry route preference fields.' };
    },
    charging: query => request('charging', '', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }).toString()
    }, data => Array.isArray(data.elements) && !data.remark)
  };
}

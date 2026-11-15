import { https, jsonFetch } from './security.mjs';

// Preview only: JWKS are PUBLIC signing keys, never access/refresh tokens.
// Pin discovery to the configured HTTPS Auth0 issuer; no token-supplied URLs.
// Fail closed on DNS, TLS, fetch, parse or key-validation errors.
let cache;
let pending;

export async function fetchPreviewJwks(issuer, fetcher = fetch, now = Date.now) {
  const url = https(issuer);
  if (url.href !== issuer || url.pathname !== '/') throw Error('configuration');
  if (cache && cache.issuer === issuer && cache.expires > now()) return cache.jwks;
  if (pending && pending.issuer === issuer) return pending.promise;

  const promise = (async () => {
    const result = await jsonFetch(fetcher, new URL('/.well-known/jwks.json', url).href);
    if (!Array.isArray(result?.keys) || result.keys.length < 1 || result.keys.length > 20) throw Error('configuration');
    const keys = result.keys.filter(k =>
      k && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === 'RS256') && !k.d &&
      typeof k.kid === 'string' && k.kid.length > 0 && k.kid.length <= 256 &&
      typeof k.n === 'string' && k.n.length > 100 &&
      typeof k.e === 'string' && k.e.length > 0
    ).map(({ kty, kid, use, alg, n, e }) => ({ kty, kid, use, alg, n, e }));
    if (!keys.length || new Set(keys.map(k => k.kid)).size !== keys.length) throw Error('configuration');
    const jwks = { keys };
    cache = { issuer, jwks, expires: now() + 600000 };
    return jwks;
  })();
  pending = { issuer, promise };
  try { return await promise; }
  finally { if (pending?.promise === promise) pending = undefined; }
}

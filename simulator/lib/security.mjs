import { createHash, createCipheriv, createDecipheriv, randomBytes, createPublicKey, verify } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('base64url');
export const random = () => randomBytes(32).toString('base64url');
// RFC 7519 §4.1.3: aud is a string or an array of case-sensitive strings.
// Only accept tokens explicitly naming this resource; never use substring matching.
export function matchesAudience(actual, expected) {
  if (typeof expected !== 'string' || !expected) return false;
  if (typeof actual === 'string') return actual === expected;
  return Array.isArray(actual) && actual.length > 0 &&
    actual.every(value => typeof value === 'string' && value.length > 0) &&
    actual.includes(expected);
}

export const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' };
export function https(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('configuration');
  return u;
}
export function configuration(env) {
  const origin = https(env.APP_ORIGIN);
  if (origin.origin !== env.APP_ORIGIN) throw Error('configuration');
  const issuer = env.MCP_AUTH_ISSUER;
  https(issuer);
  const audience = origin.origin + '/mcp';
  const jwks = JSON.parse(env.MCP_AUTH_JWKS);
  const allowedSubject = typeof env.MCP_ALLOWED_SUBJECT === 'string'
    ? env.MCP_ALLOWED_SUBJECT.trim() : '';
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || !allowedSubject) throw Error('configuration');
  // Backwards-compatible with the original Vercel variable's misspelled name.
  // Never switch encryption keys silently when both names are configured differently.
  const primaryKey = env.TOKEN_ENCRYPTION_KEY_BASE64;
  const legacyKey = env.TOKEN_ENCRYPTON_KEY_BASE64;
  if (primaryKey && legacyKey && primaryKey !== legacyKey) throw Error('configuration');
  const encodedKey = primaryKey || legacyKey;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey || '')) throw Error('configuration');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || !env.TESLA_CLIENT_ID || !env.TESLA_CLIENT_SECRET) throw Error('configuration');
  const fleet = env.TESLA_FLEET_REGION === 'eu' ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com' : env.TESLA_FLEET_REGION === 'na' ? 'https://fleet-api.prd.na.vn.cloud.tesla.com' : null;
  if (!fleet || env.TESLA_BACKEND_ENABLED !== 'true') throw Error('disabled');
  return { env: { ...env, MCP_ALLOWED_SUBJECT: allowedSubject }, origin: origin.origin, issuer, audience, jwks, key, fleet, callback: origin.origin + '/oauth/tesla/callback' };
}
export function seal(value, key, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64url')).join('.');
}
export function unseal(value, key, context) {
  const [iv, tag, data] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
}
// Only the independent authorization server's signed access tokens are accepted.
// Tesla tokens and ID tokens cannot substitute for resource-scoped MCP tokens.
export function authenticate(request, config, scope, now = Date.now()) {
  const raw = request.headers.get('authorization') || '';
  if (!raw.startsWith('Bearer ') || raw.length > 16384) throw Error('unauthorized');
  const parts = raw.slice(7).split('.');
  if (parts.length !== 3) throw Error('unauthorized');
  const h = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const p = JSON.parse(Buffer.from(parts[1], 'base64url'));
  // Auth0 API access tokens normally carry typ=JWT; RFC 9068 tokens use at+jwt.
  // Accept both ONLY with the API-specific audience and full signature/claim checks.
  // ID tokens (whose audience is the OAuth client ID) still cannot authenticate.
  if (h.alg !== 'RS256' || !['at+jwt', 'JWT'].includes(h.typ) ||
      typeof h.kid !== 'string' || h.crit) throw Error('unauthorized');
  const keys = config.jwks.keys.filter(k => k.kid === h.kid && k.kty === 'RSA' && !k.d && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (keys.length !== 1) throw Error('unauthorized');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  if (key.asymmetricKeyDetails.modulusLength < 2048 || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw Error('unauthorized');
  const seconds = now / 1000;
  if (p.iss !== config.issuer || !matchesAudience(p.aud, config.audience) || p.sub !== config.env.MCP_ALLOWED_SUBJECT || !Number.isFinite(p.exp) || p.exp <= seconds || !Number.isFinite(p.iat) || p.iat > seconds + 30 || p.exp <= p.iat || p.exp - p.iat > 86400 || (p.nbf !== undefined && (!Number.isFinite(p.nbf) || p.nbf > seconds)) || typeof p.scope !== 'string' || !p.scope.split(' ').includes(scope)) throw Error('unauthorized');
  return p.sub;
}
export async function jsonFetch(fetcher, url, options = {}, statusErrors = {}, timeoutMs = 8000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw Error('configuration');
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  // Never propagate remote response bodies, URLs, or exception messages.
  // Distinguish selected, documented HTTP statuses without exposing upstream bodies.
  if (!response.ok) throw Error(Object.hasOwn(statusErrors, response.status) ? statusErrors[response.status] : response.status === 401 || response.status === 403 ? 'reauthorize' : 'upstream');
  if (Number(response.headers.get('content-length')) > 1048576) throw Error('upstream');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1048576) { await reader.cancel(); throw Error('upstream'); } chunks.push(value); }
  return JSON.parse(Buffer.concat(chunks).toString());
}

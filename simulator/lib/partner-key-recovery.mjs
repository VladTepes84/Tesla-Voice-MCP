import { configuredPartnerDomain, matchesPublicOrigin } from './public-origin.mjs';
// Read-only Partner lookup used only by the one-use, same-origin consent route.
// It never registers a domain or invokes a vehicle endpoint.
import { createHash, createPublicKey, ECDH } from 'node:crypto';
import { consumeTeslaRequestReservation } from './request-budget.mjs';
import { validateTeslaPublicKey } from '../api/tesla-public-key.mjs';

export const REGISTERED_TESLA_DOMAIN = 'mcp.example.invalid'; // synthetic test fixture
export const TESLA_PARTNER_TOKEN_ENDPOINT = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
export const TESLA_EU_FLEET_API = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
export const PARTNER_KEY_LOOKUP_RESULT_KEY = 'tesla-partner-key-lookup-eu-result-v1';
export const PARTNER_REGISTER_RECOVERY_MARKER = 'tesla-partner-register-eu-recovery-once-v1';

export function validatePartnerKeyResponse(payload) {
  const raw = payload?.response?.public_key;
  if (typeof raw !== 'string' || raw.length > 8192) throw Error('partner_key_response_field_unverified');
  // Tesla documents that this endpoint returns the registered key, but not
  // its JSON encoding. Accept equivalent public representations: PEM text,
  // base64-wrapped PEM/SPKI DER, or the hex P-256 point. Every candidate is
  // normalized and must pass the existing strict P-256 PEM validator.
  // Never derive from private material, generate, rotate, or accept another curve.
  const pemCandidates = [];
  const derCandidates = [];
  const addPem = value => {
    if (typeof value !== 'string') return;
    const pem = value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')
      .replace(/\r\n/g, '\n').trim() + '\n';
    if (/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n$/.test(pem)) {
      pemCandidates.push(pem);
    }
  };
  addPem(raw);

  // Base64 may be line-wrapped or omit trailing padding.
  const compact = raw.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 !== 1) {
    const decoded = Buffer.from(compact, 'base64');
    const canonical = decoded.toString('base64').replace(/=+$/, '');
    if (canonical === compact.replace(/=+$/, '')) {
      addPem(decoded.toString('utf8'));
      derCandidates.push(decoded);
    }
  }

  const candidates = [];
  // Tesla's protocol encodes public points as 04 || X(32) || Y(32).
  // Partner response examples also use its hex representation. Validate the
  // point on P-256 before constructing a public-only JWK; never infer a curve.
  if (/^04[0-9a-fA-F]{128}$/.test(raw)) {
    try {
      const point = ECDH.convertKey(Buffer.from(raw, 'hex'), 'prime256v1',
        undefined, undefined, 'uncompressed');
      const key = createPublicKey({ format: 'jwk', key: {
        kty: 'EC', crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url')
      } });
      candidates.push({ key, pem: key.export({ format: 'pem', type: 'spki' }).toString() });
    } catch { /* invalid/off-curve points are rejected without exposing bytes */ }
  }
  for (const pemCandidate of pemCandidates) {
    try { candidates.push({ key: createPublicKey(pemCandidate), pem: pemCandidate }); }
    catch { /* invalid PEM is not retained or exposed */ }
  }
  for (const derBytes of derCandidates) {
    try {
      const key = createPublicKey({ key: derBytes, format: 'der', type: 'spki' });
      candidates.push({ key, pem: key.export({ format: 'pem', type: 'spki' }).toString() });
    } catch { /* only valid public SPKI DER is considered */ }
  }

  let der, pem, wrongCurve = false;
  for (const candidate of candidates) {
    const key = candidate.key;
    if (key.asymmetricKeyType !== 'ec' ||
        !['prime256v1', 'secp256r1'].includes(key.asymmetricKeyDetails?.namedCurve)) {
      wrongCurve = true;
      continue;
    }
    try {
      pem = validateTeslaPublicKey(Buffer.from(candidate.pem, 'utf8').toString('base64'));
      der = createPublicKey(pem).export({ format: 'der', type: 'spki' });
      break;
    } catch { /* a candidate that fails the canonical validator is rejected */ }
  }
  if (!pem) {
    const error = Error(wrongCurve
      ? 'partner_key_response_curve_unverified'
      : 'partner_key_response_encoding_unverified');
    // Structural metadata only: no key bytes, prefix, hash, or provider body.
    error.publicKeyShape = raw.length === 0 ? 'empty'
      : /^[0-9a-fA-F]+$/.test(raw) ? 'hex'
      : raw.includes('-----BEGIN ') ? 'pem'
      : /^[A-Za-z0-9+/=\s]+$/.test(raw) ? 'base64' : 'other';
    error.publicKeyLength = raw.length;
    throw error;
  }
  return {
    found: true,
    public_key_pem_base64: Buffer.from(pem, 'utf8').toString('base64'),
    spki_sha256: createHash('sha256').update(der).digest('hex')
  };
}

export async function lookupRegisteredPartnerKey({ env, fetcher, approved = false,
  budgetReservation, reserveRequests } = {}) {
  // Two explicit gates, including a Production-only environment variable,
  // are required in addition to supplying the fetcher. No automatic network.
  // The same owner-controlled Partner API gate covers registration and this
  // read-only status lookup. The separate `approved` argument is set only by
  // the one-use same-origin consent form.
  if (!approved || env?.TESLA_PARTNER_REGISTRATION_APPROVED !== 'true'
      || env.VERCEL_ENV !== 'production') throw Error('partner_key_check_not_approved');
  if (!matchesPublicOrigin(env.APP_ORIGIN, env)
      || env.TESLA_FLEET_REGION !== 'eu'
      || typeof env.TESLA_CLIENT_ID !== 'string' || !env.TESLA_CLIENT_ID
      || typeof env.TESLA_CLIENT_SECRET !== 'string' || !env.TESLA_CLIENT_SECRET
      || typeof fetcher !== 'function') throw Error('partner_key_check_configuration');

  // The Partner token and public-key lookup are separate HTTP requests. Refuse
  // direct callers that have not reserved both slots in the shared daily cap.
  if (!budgetReservation) {
    if (typeof reserveRequests !== 'function') throw Error('partner_key_budget_unavailable');
    try { budgetReservation = await reserveRequests(2); }
    catch (err) {
      if (err?.message === 'budget' || err?.message === 'configuration') throw err;
      throw Error('partner_key_budget_unavailable');
    }
  }
  if (!consumeTeslaRequestReservation(budgetReservation, 2)) throw Error('partner_key_budget_unavailable');

  // Tesla's client_credentials Partner Token is separate from the Tesla owner
  // token. No scope for vehicle commands, charging, location or wake is asked.
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    audience: TESLA_EU_FLEET_API,
    // Tesla documents scope as optional, but the 403 suggests insufficient
    // authorization; request only read-only scopes already needed for battery.
    scope: 'openid vehicle_device_data'
  });
  // Apply a fresh timeout to each request; never share an expiring signal across both calls.
  const requestOpts = () => ({ redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  let token;
  try {
    const response = await fetcher(TESLA_PARTNER_TOKEN_ENDPOINT, {
      ...requestOpts(), method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    if (response.status !== 200) throw Error('partner_auth_failed');
    const json = await response.json();
    token = json?.access_token;
    if (typeof token !== 'string' || !token || token.length > 8192) throw Error('partner_auth_failed');
  } catch {
    // No token, Client Secret, Tesla response body or query values in errors.
    throw Error('partner_auth_failed');
  }

  const url = TESLA_EU_FLEET_API + '/api/1/partner_accounts/public_key?domain='
      + encodeURIComponent(configuredPartnerDomain(env));
  try {
    const response = await fetcher(url, {
      ...requestOpts(), method: 'GET',
      // Fleet API requires Content-Type even for GET without a request body.
      // Missing Content-Type can cause HTTP 406: documented Tesla convention.
      headers: { authorization: 'Bearer ' + token, accept: 'application/json',
        'content-type': 'application/json' }
    });
    if (response.status === 404) return { found: false, status: 'not_found' };
    if (response.status === 412) return { found: false, status: 'partner_not_registered' };
    // For a future explicitly authorized diagnostic read: record only the HTTP
    // status, an allowlisted Tesla error enum and a sanitized request trace ID.
    // Never emit response payloads, access tokens, client secrets or URLs.
    if (response.status !== 200) {
      if (Number.isInteger(response.status) && response.status >= 400 && response.status <= 599) {
        const diagnostic = Error('partner_key_http_' + response.status);
        const txid = response.headers.get('x-txid');
        if (typeof txid === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(txid)) {
          diagnostic.teslaTxid = txid;
        }
        const permittedCodes = new Set([
          'unauthorized_missing_scopes', 'insufficient_scope', 'forbidden',
          'not_found', 'invalid_resource', 'invalid_request',
          'unauthorized_client', 'partner_not_registered', 'access_denied'
        ]);
        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize >= 0 && declaredSize <= 4096) {
          try {
            const payload = await response.json();
            if (permittedCodes.has(payload?.error)) diagnostic.teslaError = payload.error;
          } catch { /* a non-JSON Tesla body is not logged or exposed */ }
        }
        throw diagnostic;
      }
      throw Error('partner_key_lookup_unavailable');
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw Error('partner_key_response_json_unverified'); }
    return validatePartnerKeyResponse(payload);
  } catch (err) {
    // Only explicitly allowlisted coarse diagnostics; no external API payloads.
    if (/^partner_key_http_[45]\d{2}$/.test(err?.message || '') ||
        ['partner_key_response_json_unverified', 'partner_key_response_field_unverified',
          'partner_key_response_encoding_unverified', 'partner_key_response_curve_unverified',
          'partner_key_response_key_unverified'].includes(err?.message)) throw err;
    throw Error('partner_key_lookup_unavailable');
  }
}

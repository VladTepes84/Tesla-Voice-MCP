// Offline preparation for a future Tesla OAuth flow. Does NOT manage credentials or tokens.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TESLA_AUTHORIZE_ENDPOINT = 'https://auth.tesla.com/oauth2/v3/authorize';
export const TESLA_EU_API = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
export const READ_ONLY_SCOPES = Object.freeze(['openid', 'offline_access', 'vehicle_device_data']);

export function createOAuthState() {
  return randomBytes(32).toString('base64url');
}

export function validateOAuthState(expected, supplied) {
  const pattern = /^[A-Za-z0-9_-]{43}$/;
  if (typeof expected !== 'string' || typeof supplied !== 'string' ||
      !pattern.test(expected) || !pattern.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function validateCallbackConfig(origin, callbackUrl) {
  let base, callback;
  try { base = new URL(origin); callback = new URL(callbackUrl); }
  catch { throw new TypeError('Invalid OAuth URL'); }
  if (base.protocol !== 'https:' || base.origin !== origin || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) throw new TypeError('Invalid HTTPS origin');
  if (callback.protocol !== 'https:' || callback.origin !== base.origin ||
      callback.username || callback.password || callback.search || callback.hash ||
      callback.pathname !== '/oauth/tesla/callback') throw new TypeError('Invalid HTTPS callback URL');
  return { origin: base.origin, callbackUrl: callback.href };
}

export function buildTeslaAuthorizationUrl({ clientId, origin, callbackUrl, state }) {
  if (typeof clientId !== 'string' || !clientId.trim() || clientId !== clientId.trim()) {
    throw new TypeError('Client ID is missing or invalid');
  }
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new TypeError('Invalid OAuth state');
  }
  const config = validateCallbackConfig(origin, callbackUrl);
  const url = new URL(TESLA_AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('scope', READ_ONLY_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

// Do not export a handler that exchanges authorization codes without secure storage
// for state, account binding, encrypted tokens, and atomic refresh-token rotation.

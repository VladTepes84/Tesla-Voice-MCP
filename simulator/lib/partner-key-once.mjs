import { matchesPublicOrigin } from './public-origin.mjs';
// Single-use, build-only Tesla Partner public-key inspection.
// No HTTP route. Not connected to vehicle endpoints, no key registration.
// The Redis marker is consumed BEFORE any Tesla HTTP requests to prevent replay.
import { persistentStore } from './store.mjs';
import { reserveTeslaRequests } from './request-budget.mjs';
import { lookupRegisteredPartnerKey, REGISTERED_TESLA_DOMAIN } from './partner-key-recovery.mjs';

export const CHECK_MARKER = 'tesla-partner-public-key-read:authorized-2026-10-30:third-readonly-scopes';
const TEN_YEARS_IN_SECONDS = 315360000;

export async function runPartnerKeyOnce({
  env = process.env, fetcher = fetch, storeFactory = persistentStore, now = Date.now,
  lookup = lookupRegisteredPartnerKey, emit = console.log
} = {}) {
  if (env.VERCEL_ENV !== 'production') {
    emit('TESLA_PARTNER_CHECK=skipped_preview');
    return 'skipped_preview';
  }
  // Strictly bind this one-off action to the existing Tesla-only project.
  if (!matchesPublicOrigin(env.APP_ORIGIN, env) ||
      env.TESLA_FLEET_REGION !== 'eu' ||
      !env.TESLA_CLIENT_ID || !env.TESLA_CLIENT_SECRET ||
      !env.TOKEN_STORE_REST_URL || !env.TOKEN_STORE_REST_TOKEN) {
    emit('TESLA_PARTNER_CHECK=missing_or_mismatched_configuration');
    return 'missing_or_mismatched_configuration';
  }

  let store;
  try {
    store = storeFactory(env, fetcher);
    if (await store.get(CHECK_MARKER)) {
      emit('TESLA_PARTNER_CHECK=already_reserved_no_network');
      return 'already_reserved_no_network';
    }
  } catch {
    emit('TESLA_PARTNER_CHECK=one_time_reservation_unavailable');
    return 'one_time_reservation_unavailable';
  }
  let budgetReservation;
  try {
    // This diagnostic is also two Tesla requests and shares the same ceiling.
    budgetReservation = await reserveTeslaRequests({ store, env, now, count: 2 });
  } catch {
    emit('TESLA_PARTNER_CHECK=request_budget_unavailable');
    return 'request_budget_unavailable';
  }
  let reserved;
  try { reserved = await store.once(CHECK_MARKER, TEN_YEARS_IN_SECONDS); }
  catch {
    emit('TESLA_PARTNER_CHECK=one_time_reservation_unavailable');
    return 'one_time_reservation_unavailable';
  }
  if (!reserved) {
    emit('TESLA_PARTNER_CHECK=already_reserved_no_network');
    return 'already_reserved_no_network';
  }

  try {
    // Explicitly authorized one-off action; no persistent approval env flag.
    const approvedEnv = { ...env, TESLA_PARTNER_KEY_LOOKUP_APPROVED: 'true' };
    const outcome = await lookup({ env: approvedEnv, fetcher, approved: true, budgetReservation });
    if (!outcome.found) {
      const status = outcome.status === 'partner_not_registered' ? 'partner_not_registered' : 'not_found';
      emit('TESLA_PARTNER_CHECK=' + status);
      return status;
    }
    // Only P-256 PUBLIC PEM, validated by the lookup helper, is printed.
    // Never print Tesla tokens, Client Secret, VIN, Redis token or provider bodies.
    emit('TESLA_PARTNER_CHECK=public_key_found');
    emit('TESLA_PARTNER_PUBLIC_SPKI_SHA256=' + outcome.spki_sha256);
    emit('TESLA_PARTNER_PUBLIC_PEM_BASE64=' + outcome.public_key_pem_base64);
    return 'public_key_found';
  } catch (err) {
    const allow = new Set(['partner_auth_failed', 'partner_key_lookup_unavailable',
      'partner_key_check_configuration', 'partner_key_check_not_approved',
      'partner_key_response_json_unverified', 'partner_key_response_field_unverified',
      'partner_key_response_encoding_unverified', 'partner_key_response_curve_unverified',
      'partner_key_response_key_unverified']);
    const httpStatusOnly = /^partner_key_http_[45]\d{2}$/.test(err?.message || '');
    const status = allow.has(err?.message) || httpStatusOnly ? err.message : 'unexpected_failure';
    emit('TESLA_PARTNER_CHECK=' + status);
    // Print only explicitly sanitized fields from our own client helper.
    if (httpStatusOnly && typeof err.teslaError === 'string' &&
        new Set(['unauthorized_missing_scopes','insufficient_scope','forbidden',
          'not_found','invalid_resource','invalid_request',
          'unauthorized_client','partner_not_registered','access_denied']).has(err.teslaError)) {
      emit('TESLA_PARTNER_ERROR_ENUM=' + err.teslaError);
    }
    if (httpStatusOnly && typeof err.teslaTxid === 'string' &&
        /^[A-Za-z0-9_-]{8,100}$/.test(err.teslaTxid)) {
      emit('TESLA_PARTNER_TRACE_ID=' + err.teslaTxid);
    }
    return status;
  }
}

import { configuredPublicOrigin, configuredPartnerDomain } from './public-origin.mjs';
import {nativeNavigationEnabled,nativeStationSelections,parseNativeCoordinates} from './native-navigation-candidates.mjs';
import {parseRefIdWaypointList} from './frequent-waypoint-catalog.mjs';
import { gpsRouteCandidateEnabled } from './gps-route-activation.mjs';
import { withGPSExecutionBudget } from './gps-route-execution-budget.mjs';
import { withGPSFixtureNavigationFence, gpsNavigationFenceStatus } from './gps-route-fixture-fence.mjs';
import { chargingPreferences } from './charging-preferences.mjs';
import { savedTripPlaces } from './saved-trip-places.mjs';
import { commandLifecycle } from './command-lifecycle.mjs';
import { tripNavigation } from './trip-navigation.mjs';
import { destinationSearchCache } from './destination-search-cache.mjs';
import { googlePlacesProductionEnabled } from './google-waypoints.mjs';
import { hash, random, seal, unseal, headers, authenticate, jsonFetch } from './security.mjs';
import { createHmac } from 'node:crypto';
import { reserveTeslaRequests as reserveBudgetRequests, readTeslaRequestBudget, effectiveTeslaRequestLimit } from './request-budget.mjs';
import { createCommandAuthorization } from './command-authorization.mjs';
import { provisionTeslaP256Once, readStoredTeslaP256Private, readStoredTeslaP256Public, TESLA_P256_ORIGIN } from './partner-p256-identity.mjs';
import { TESLA_PUBLIC_KEY_PATH } from '../api/tesla-public-key.mjs';
import { prepareOperation, operationDefinitions } from './operation-plans.mjs';
import { registerTeslaPartnerEUOnce, PARTNER_REGISTER_MARKER, PARTNER_REGISTER_RESULT_KEY } from './partner-registration.mjs';
import { lookupRegisteredPartnerKey, PARTNER_KEY_LOOKUP_RESULT_KEY,
  PARTNER_REGISTER_RECOVERY_MARKER } from './partner-key-recovery.mjs';
// Vehicle permissions requested by the owner; granting these does not expose commands.
export const SCOPES = ['openid', 'offline_access', 'vehicle_device_data', 'vehicle_location', 'vehicle_cmds', 'vehicle_charging_cmds'];
export function nativeAcknowledgementResult(mode) {
  if (mode === 'experimental_native_refid_waypoints') return {
    navigation_set: 'unverified',
    note: 'ActionStatus OK confirms only the command acknowledgement; waypoint configuration and display visibility remain unverified.'
  };
  return { note: 'Tesla accepted the request. The command result does not prove that the vehicle completed the action.' };
}
const VEHICLE_PERMISSION_SCOPES = Object.freeze({
  vehicle_information: 'vehicle_device_data',
  vehicle_location: 'vehicle_location',
  vehicle_commands: 'vehicle_cmds',
  charging_management: 'vehicle_charging_cmds'
});
// The JWT is read only as part of the HTTPS token response received directly
// from Tesla; it is never accepted as an MCP caller's authentication token.
function teslaTokenScopes(token) {
  if (typeof token !== 'string' || token.length > 16384) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Object.hasOwn(claims, 'scp')) return undefined;
    return Array.isArray(claims.scp) && claims.scp.every(s => typeof s === 'string' && !!s) ? claims.scp : null;
  } catch { return undefined; }
}
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const COOKIE = '__Host-tesla-oauth';
const TTL = 90 * 24 * 3600;

// Chat clients and link wrappers may append attribution/bypass parameters or
// serialize a query separator as an escaped ampersand. The ticket is the only
// query value used for authorization; ignore unrelated parameters, but keep a
// single ticket, a bounded query, and the exact generated ticket alphabet.
function ticketFromBrowserUrl(url, { allowWrapperParams = false } = {}) {
  const params = url.searchParams;
  if (url.search.length > 2048 || params.getAll('ticket').length !== 1) return null;
  const extraKeys = [...params.keys()].filter(key => key !== 'ticket');
  if (!allowWrapperParams && (params.getAll('utm_source').length > 1 ||
      (params.has('utm_source') && params.get('utm_source') !== 'chatgpt.com') ||
      extraKeys.some(key => key !== 'utm_source'))) return null;
  let ticket = params.get('ticket');
  if (allowWrapperParams) {
    // Some iOS/ChatGPT handoffs encode the attribution separator inside the
    // ticket value instead of appending it as a query parameter. Strip only
    // that exact wrapper suffix, then validate the generated ticket unchanged.
    ticket = ticket.replace(/\\?&utm_source=chatgpt\.com$/, '');
    if (ticket.endsWith('\\')) ticket = ticket.slice(0, -1);
  } else if (ticket.endsWith('\\') && params.get('utm_source') === 'chatgpt.com') {
    ticket = ticket.slice(0, -1);
  }
  return /^[A-Za-z0-9_-]{43}$/.test(ticket) ? ticket : null;
}

export function createTeslaBackend({ config: c, store, fetcher = fetch, now = Date.now, verifiedWaypointPlaceIds,
  provisionKey = provisionTeslaP256Once, readKeyPublic = readStoredTeslaP256Public,
  partnerRegistrar = registerTeslaPartnerEUOnce,
  partnerKeyLookup = lookupRegisteredPartnerKey, gpsRouteProxyFixture = null, logger = console } = {}) {
  // The injected fixture and real candidate activation are separate. A real
  // activation requires matching explicit schema/flag and the existing release gates.
  const gpsRouteFixtureEnabled = c.env.TESLA_GPS_ROUTE_FIXTURE_ENABLED==='true' && typeof gpsRouteProxyFixture==='function';
  const gpsRouteExecutionEnabled=gpsRouteFixtureEnabled||gpsRouteCandidateEnabled(c);
  const nativeCoordinatesEnabled=nativeNavigationEnabled(c,'coordinates'),nativeSuperchargerEnabled=nativeNavigationEnabled(c,'supercharger'),nativeWaypointsEnabled=nativeNavigationEnabled(c,'waypoints');
  const nativeSelections=nativeStationSelections({config:c,store,now});
  const destinationCache = destinationSearchCache({ config: c, store, now });
  const nativeMode=(operation,args)=>operation==='navigation_sc_request'&&nativeSuperchargerEnabled?'experimental_native_supercharger':operation==='navigation_waypoints_request'&&nativeCoordinatesEnabled&&typeof args?.waypoints==='string'&&args.waypoints.includes(';')?'experimental_native_coordinate_batch':operation==='navigation_waypoints_request'&&nativeWaypointsEnabled&&parseRefIdWaypointList(args?.waypoints)?'experimental_native_refid_waypoints':null;
  const boundedPlan=plan=>plan.operation==='navigation_gps_request'&&gpsRouteExecutionEnabled||nativeMode(plan.operation,plan.args)!==null;
  const operationOptions=(statusOnly=false,gpsDiagnosticPhase=null)=>({nativeWaypointsEnabled:nativeWaypointsEnabled||statusOnly,coordinateWaypointsEnabled:nativeCoordinatesEnabled||statusOnly,nativeSuperchargerEnabled:nativeSuperchargerEnabled||statusOnly,gpsRouteFixtureEnabled:gpsRouteExecutionEnabled||statusOnly,gpsDiagnosticPhase,statusOnly,...(verifiedWaypointPlaceIds?{verifiedWaypointPlaceIds}:{})});
  async function commandOperationOptions(subject,operation,args,statusOnly=false,gpsDiagnosticPhase=null){
    const options=operationOptions(statusOnly,gpsDiagnosticPhase);
    if(statusOnly||operation!=='navigation_waypoints_request'||!nativeWaypointsEnabled||!googlePlacesProductionEnabled(c.env))return options;
    const ids=parseRefIdWaypointList(args?.waypoints);
    if(!ids)return options;
    const googlePlacesVerifiedIds=await destinationCache.verifyGooglePlaceIds(subject,ids);
    return {...options,googlePlacesVerifiedIds};
  }
  const withNavigationFixtureFence = (subject, plan, requestId, run) => plan.group==='navigation'
    ? withGPSFixtureNavigationFence({store,config:c,subject,plan,requestId,enabled:boundedPlan(plan),run}) : run();
  const commandAuthorization = createCommandAuthorization({ store, key: c.key, now, operationOptions: commandOperationOptions });
  const tokenKey = subject => 'tokens:' + hash(c.issuer + '\n' + subject);
  const response = (message, status, extra = {}) => new Response(message, { status, headers: { ...headers, ...extra } });
  async function reserveTeslaRequest(count = 1) {
    return reserveBudgetRequests({ store, env: c.env, now, count });
  }
  function observeReadStatus(kind) {
    return async (url, options) => {
      const response = await fetcher(url, options);
      console.info('TESLA_READ_HTTP_STATUS', kind, Number.isInteger(response.status) ? response.status : 0);
      return response;
    };
  }
  async function exchange(params, reserved = false) {
    if (!reserved) await reserveTeslaRequest();
    console.info('TESLA_OAUTH_STAGE', 'budget_reserved');
    const observedFetch = async (url, options) => {
      try {
        const result = await fetcher(url, options);
        console.info('TESLA_TOKEN_HTTP_STATUS', Number.isInteger(result.status) ? result.status : 0);
        return result;
      } catch (err) {
        console.info('TESLA_TOKEN_TRANSPORT', err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'failure');
        throw err;
      }
    };
    const data = await jsonFetch(observedFetch, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.env.TESLA_CLIENT_ID, ...params }) });
    const responseScopes = typeof data?.scope === 'string' ? data.scope.split(' ') : undefined;
    const jwtScopes = teslaTokenScopes(data?.access_token);
    const availableScopes = [responseScopes, jwtScopes].filter(s => s !== undefined);
    const scopeAllowed = scopes => Array.isArray(scopes) && scopes.includes('vehicle_device_data') && scopes.every(s => SCOPES.includes(s));
    const scopesValid = (data?.scope === undefined || typeof data.scope === 'string') && availableScopes.length > 0 && availableScopes.every(scopeAllowed);
    // Categorical flags only; do not log the response, tokens or scope values.
    console.info('TESLA_TOKEN_SHAPE', JSON.stringify({
      access_present: typeof data?.access_token === 'string' && !!data.access_token,
      refresh_present: typeof data?.refresh_token === 'string' && !!data.refresh_token,
      bearer_type: typeof data?.token_type === 'string' && data.token_type.toLowerCase() === 'bearer',
      expiry_valid: Number.isFinite(data?.expires_in) && data.expires_in >= 60 && data.expires_in <= 86400,
      scope_present: typeof data?.scope === 'string',
      jwt_scp_present: Array.isArray(jwtScopes),
      required_scope_present: availableScopes.some(s => Array.isArray(s) && s.includes('vehicle_device_data')),
      scopes_allowed: scopesValid
    }));
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384 || typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 16384 || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in < 60 || data.expires_in > 86400) throw Error('upstream');
    if (!scopesValid) throw Error('reauthorize');
    const scopes = [...new Set(availableScopes.flat())];
    return { access: data.access_token, refresh: data.refresh_token, scopes,
      expires: now() + data.expires_in * 1000, refreshExpires: now() + TTL * 1000 };
  }
  async function withTokens(subject, operation) {
    const key = tokenKey(subject), lock = await store.lock(key);
    try { return await operation(key, lock); } finally { await lock.release(); }
  }
  async function createBrowserOAuth(subject) {
    const state = random(), browser = random(), verifier = random();
    const txkey = 'oauth:' + hash(state);
    await store.put(txkey, seal({
      subject, browser: hash(browser), verifier, expires: now() + 600000
    }, c.key, txkey), 600);
    const url = new URL('https://auth.tesla.com/oauth2/v3/authorize');
    url.search = new URLSearchParams({
      client_id: c.env.TESLA_CLIENT_ID, response_type: 'code',
      redirect_uri: c.callback, scope: SCOPES.join(' '),
      state, code_challenge: hash(verifier), code_challenge_method: 'S256',
      require_requested_scopes: 'true'
    });
    return {
      authorizationUrl: url.href,
      cookie: `${COOKIE}=${browser}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`
    };
  }
  async function start(request) {
    if (request.method !== 'POST') return response('', 405, { allow: 'POST' });
    if (request.headers.get('origin') !== c.origin ||
        request.headers.get('content-type') !== 'application/json') return response('', 403);
    let subject;
    try { subject = authenticate(request, c, 'tesla:connect', now()); }
    catch { return response('Unauthorized', 401); }
    if (!await store.once('connect-rate:' + hash(subject), 60))
      return response('Try again later.', 429);
    const tx = await createBrowserOAuth(subject);
    return Response.json({ authorization_url: tx.authorizationUrl }, {
      headers: { ...headers, 'set-cookie': tx.cookie }
    });
  }
  // Authenticated MCP issues a 5-minute single-use handoff ticket; this is
  // not a Tesla token, does not contact Tesla, and has no vehicle permissions.
  async function prepareConnect(subject) {
    // Repeated calls from ChatGPT should not create fresh Tesla consent links
    // when this account already has a locally valid refresh token. This check
    // only reads the encrypted local record; it never contacts Tesla.
    const status = await connectionStatus(subject);
    if (status.connected) return {
      source: 'EXISTING_TESLA_CONNECTION',
      connected: true,
      reauthorization_required: false,
      note: 'Tesla account already connected; no new OAuth link was created.'
    };
    if (!await store.once('connect-rate:' + hash(subject), 60)) throw Error('rate');
    // Do not decrypt or log tokens; this only checks whether a record exists.
    console.info('TESLA_TOKEN_RECORD', (await store.get(tokenKey(subject))) ? 'present' : 'absent');
    const ticket = random();
    const key = 'connect-ticket:' + hash(ticket);
    await store.put(key, seal({ subject, expires: now() + 300000 }, c.key, key), 300);
    console.info('TESLA_HANDOFF_EVENT', 'ticket_created');
    return {
      source: 'TESLA_OAUTH_LINK',
      connect_url: c.origin + '/oauth/tesla/launch?ticket=' + encodeURIComponent(ticket),
      expires_in_seconds: 300,
      note: 'Open the link to authorize your Tesla account at auth.tesla.com. No vehicle data is read.'
    };
  }
  async function connectionStatus(subject, { includeReadReadiness = false } = {}) {
    const enabledFeatures = {
      cached_vehicle_data: c.env.TESLA_READ_ENABLED === 'true',
      vehicle_connectivity: c.env.TESLA_READ_ENABLED === 'true',
      vehicle_mobile_access: c.env.TESLA_READ_ENABLED === 'true',
      live_vehicle_data: c.env.TESLA_READ_ENABLED === 'true',
      vehicle_reading_history: c.env.TESLA_READ_ENABLED === 'true',
      vehicle_location: c.env.TESLA_READ_ENABLED === 'true' && c.env.TESLA_LOCATION_ENABLED === 'true',
      charging_history: c.env.TESLA_READ_ENABLED === 'true',
      vehicle_command_tools: c.env.TESLA_READ_ENABLED === 'true' &&
        c.env.TESLA_COMMANDS_ENABLED === 'true' && c.env.TESLA_COMMAND_EXECUTION_ENABLED === 'true'
    };
    const key = tokenKey(subject), encrypted = await store.get(key);
    if (!encrypted) return {
      connected: false,
      enabled_features: enabledFeatures,
      vehicle_permissions: Object.fromEntries(Object.keys(VEHICLE_PERMISSION_SCOPES).map(name => [name, false])),
      all_vehicle_permissions_granted: false,
      note: 'No Tesla account is connected.'
    };
    let tokens;
    try { tokens = unseal(encrypted, c.key, key); }
    catch { throw Error('store'); }
    const scopes = Array.isArray(tokens.scopes) ? tokens.scopes : teslaTokenScopes(tokens.access);
    const permissions = Object.fromEntries(Object.entries(VEHICLE_PERMISSION_SCOPES).map(([name, scope]) =>
      [name, Array.isArray(scopes) ? scopes.includes(scope) : null]));
    const connected = tokens.invalid !== true && typeof tokens.refresh === 'string' && !!tokens.refresh && Number.isFinite(tokens.refreshExpires) && tokens.refreshExpires > now();
    let readiness;
    if (includeReadReadiness) {
      const budget = await readTeslaRequestBudget({ store, env: c.env, now });
      const refreshRequired = !Number.isFinite(tokens.expires) || tokens.expires <= now() + 60000;
      const requestsNeeded = refreshRequired ? 2 : 1;
      const vehicleConfigured = /^[A-HJ-NPR-Z0-9]{17}$/.test(c.env.TESLA_VEHICLE_VIN || '');
      const readEnabled = c.env.TESLA_READ_ENABLED === 'true';
      const permissionGranted = permissions.vehicle_information === true;
      const budgetSufficient = budget.available === true && (budget.unlimited === true || budget.remaining >= requestsNeeded);
      readiness = { read_enabled: readEnabled, vehicle_configured: vehicleConfigured,
        permission_granted: permissionGranted, refresh_required: refreshRequired,
        requests_needed: requestsNeeded, budget, budget_sufficient: budgetSufficient,
        ready: connected && readEnabled && vehicleConfigured && permissionGranted && budgetSufficient };
    }
    return {
      connected,
      enabled_features: enabledFeatures,
      access_token_valid: connected && Number.isFinite(tokens.expires) && tokens.expires > now(),
      refresh_available: connected,
      vehicle_permissions: permissions,
      all_vehicle_permissions_granted: connected && Object.values(permissions).every(value => value === true),
      checked_at: new Date(now()).toISOString(),
      ...(readiness ? { cached_read_readiness: readiness, live_vehicle_data_readiness: readiness } : {}),
      note: Array.isArray(scopes)
        ? 'Status is based on stored OAuth scopes; no Tesla request was made.'
        : 'A connection exists, but detailed permissions cannot be verified from the stored token.'
    };
  }
  async function issuePartnerTicket(prefix, payload, ttlSeconds = 300) {
    const ticket = random();
    const key = prefix + ':' + hash(ticket);
    await store.put(key, seal({ ...payload, expires: now() + ttlSeconds * 1000 }, c.key, key), ttlSeconds);
    return ticket;
  }
  async function issuePartnerCheckCode(payload, ttlSeconds = 1800) {
    const code = random().slice(0, 12);
    const key = 'partner-key-check-code:' + hash(code);
    await store.put(key, seal({ ...payload, expires: now() + ttlSeconds * 1000 }, c.key, key), ttlSeconds);
    return code;
  }
  async function prepareVehicleCommandSetup(subject) {
    const status = await connectionStatus(subject);
    if (!status.connected) throw Error('reauthorize');
    if (status.vehicle_permissions.vehicle_commands !== true) throw Error('permission');
    // One-time, idempotent key creation in existing persistent storage. The
    // operation makes no Tesla API request and sends no command to the car.
    const identity = await provisionKey({ env: c.env, storeFactory: () => store });
    const savedResult = await store.get(PARTNER_REGISTER_RESULT_KEY);
    const registrationMarker = await store.get(PARTNER_REGISTER_MARKER);
    const recoveryMarker = await store.get(PARTNER_REGISTER_RECOVERY_MARKER);
    const savedLookup = await store.get(PARTNER_KEY_LOOKUP_RESULT_KEY);
    let lookup;
    if (savedLookup) {
      try { lookup = JSON.parse(savedLookup); }
      catch { throw Error('partner_registration_state_invalid'); }
    }
    let result;
    if (savedResult) {
      try { result = JSON.parse(savedResult); } catch { throw Error('partner_registration_state_invalid'); }
    }
    const pairingResult = () => ({
      source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
      key_fingerprint_sha256: identity.sha256, partner_domain_registered: true,
      pairing_url: 'https://tesla.com/_ak/' + configuredPartnerDomain(c.env),
      vehicle_pairing_required: true, no_vehicle_command_sent: true,
      note: 'Tesla registered this application’s public key. You can now pair it with the vehicle using the official link.'
    });
    if (lookup?.status === 'mismatch') return {
      source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
      key_fingerprint_sha256: identity.sha256, partner_domain_registered: 'key_mismatch',
      registration_status: 'verification_key_mismatch', vehicle_pairing_required: false,
      no_vehicle_command_sent: true,
      note: 'Tesla has a key registered for this domain, but its fingerprint does not match. Do not pair the vehicle; verify the key stored by the backend.'
    };
    if (result?.registered === true || (lookup?.status === 'registered' && lookup.key_matches === true))
      return pairingResult();

    if (registrationMarker) {

      if (lookup?.status === 'not_found') {
        if (recoveryMarker) return {
          source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
          key_fingerprint_sha256: identity.sha256, partner_domain_registered: false,
          registration_status: 'recovery_already_attempted', vehicle_pairing_required: false,
          no_vehicle_command_sent: true,
          note: 'Tesla confirmed that the key was not registered; the single recovery attempt has already been used. No further attempt will be sent automatically.'
        };
        if (c.env.TESLA_PARTNER_REGISTRATION_APPROVED !== 'true') return {
          source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
          key_fingerprint_sha256: identity.sha256, partner_domain_registered: false,
          registration_status: 'owner_gate_disabled', vehicle_pairing_required: false,
          no_vehicle_command_sent: true,
          note: 'Tesla verified that the key is not registered. Partner registration is not enabled in the hosting Production environment; no new registration was sent.'
        };
        const ticket = await issuePartnerTicket('partner-registration-ticket', {
          subject, fingerprint: identity.sha256, recovery: true
        });
        return {
          source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
          key_fingerprint_sha256: identity.sha256, partner_domain_registered: false,
          registration_status: 'verified_not_registered',
          partner_registration_approval_url: c.origin + '/oauth/tesla/partner-registration?ticket=' + encodeURIComponent(ticket),
          partner_registration_expires_in_seconds: 300,
          vehicle_pairing_required: false, no_vehicle_command_sent: true,
          note: 'Tesla confirmed in a read-only check that this domain does not have this key registered. Open the link to approve one recovery request; it will not be sent without your click.'
        };
      }

      if (lookup?.status === 'unknown') return {
        source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
        key_fingerprint_sha256: identity.sha256, partner_domain_registered: 'unknown',
        registration_status: 'verification_unavailable', verification_error: lookup.error,
        vehicle_pairing_required: false, no_vehicle_command_sent: true,
        note: 'Tesla did not return a verifiable result. Registration will not be repeated; no vehicle command was sent.'
      };

      if (c.env.TESLA_PARTNER_REGISTRATION_APPROVED !== 'true') return {
        source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
        key_fingerprint_sha256: identity.sha256, partner_domain_registered: 'unknown',
        registration_status: 'owner_gate_disabled', vehicle_pairing_required: false,
        no_vehicle_command_sent: true,
        note: 'A previous attempt has no saved outcome. No new Tesla request was sent.'
      };
      // This read-only verification opens in a browser and requires explicit
      // confirmation; allow time to switch apps and complete the check.
      const code = await issuePartnerCheckCode({
        subject, fingerprint: identity.sha256
      });
      return {
        source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
        key_fingerprint_sha256: identity.sha256, partner_domain_registered: 'unknown',
        registration_status: 'verification_required',
        partner_registration_check_url: c.origin + '/oauth/tesla/partner-key-check',
        partner_registration_check_code: code,
        partner_registration_check_expires_in_seconds: 1800,
        vehicle_pairing_required: false, no_vehicle_command_sent: true,
        note: 'A previous attempt did not save its outcome. Open the verification page, enter the one-time code, and authorize a read-only Tesla Partner check. It will not register the domain or query the vehicle.'
      };
    }

    if (result) return {
      source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
      key_fingerprint_sha256: identity.sha256, partner_domain_registered: false,
      registration_status: 'rejected', registration_http_status: result.status,
      vehicle_pairing_required: false, no_vehicle_command_sent: true,
      note: 'Tesla did not confirm domain registration. Pairing is unavailable.'
    };

    if (c.env.TESLA_PARTNER_REGISTRATION_APPROVED !== 'true') return {
      source: 'TESLA_VIRTUAL_KEY_SETUP', key_created: identity.created,
      key_fingerprint_sha256: identity.sha256, partner_domain_registered: false,
      registration_status: 'owner_gate_disabled', vehicle_pairing_required: false,
      no_vehicle_command_sent: true,
      note: 'The key is ready, but Partner registration is not enabled in the hosting Production environment. No Tesla request was sent.'
    };
    const approvalTicket = await issuePartnerTicket('partner-registration-ticket', {
      subject, fingerprint: identity.sha256, recovery: false
    });
    return {
      source: 'TESLA_VIRTUAL_KEY_SETUP',
      key_created: identity.created,
      key_fingerprint_sha256: identity.sha256,
      public_key_url: configuredPublicOrigin(c.env) + TESLA_PUBLIC_KEY_PATH,
      partner_registration_approval_url: c.origin + '/oauth/tesla/partner-registration?ticket=' + encodeURIComponent(approvalTicket),
      partner_registration_expires_in_seconds: 300,
      partner_domain_registered: false,
      vehicle_pairing_required: false,
      no_vehicle_command_sent: true,
      note: 'The private key remains encrypted in storage. Open the link to approve one domain registration; setup itself does not contact Tesla.'
    };
  }
  async function partnerKeyCheck(request) {
    if (!['GET', 'POST'].includes(request.method)) return response('', 405, { allow: 'GET, POST' });
    const url = new URL(request.url);
    const path = '/oauth/tesla/partner-key-check';
    const pathTicket = url.pathname.match(/^\/oauth\/tesla\/partner-key-check\/([A-Za-z0-9_-]{43})$/)?.[1];
    if (url.origin !== c.origin || (url.pathname !== path && !(request.method === 'GET' && pathTicket)))
      return response('Invalid connection link.', 404);
    const html = (title, body) => response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head><body><main><h1>' + title + '</h1>' + body + '</main></body></html>',
      // Keep same-origin form POSTs' Origin header available; no ticket or code
      // is placed in the URL, and `origin` omits the page path and query.
      200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'origin',
        'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    const entryBody = '<p>Enter the one-time code provided by your MCP operator. It expires after 30 minutes and can be used once.</p><p>Clicking the button authorizes one read-only Tesla Partner check. It may use quota or incur Tesla service charges. It does not register the domain, read vehicle data, wake the vehicle, or send commands.</p><form method="post" action="' + path + '"><label for="code">One-time code</label><br><input id="code" name="code" type="text" minlength="12" maxlength="12" pattern="[A-Za-z0-9_-]{12}" inputmode="text" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" required><button type="submit" name="confirm" value="check_once">Authorize Tesla status check</button></form><p>To cancel, close this page without clicking the button.</p>';
    if (request.method === 'GET' && url.pathname === path && !url.searchParams.has('ticket'))
      return html('Tesla registration check', entryBody);
    let ticket, code, consentKey;
    if (request.method === 'GET') {
      ticket = pathTicket || ticketFromBrowserUrl(url, { allowWrapperParams: true });
      if (!ticket) return response('Invalid connection link.', 400);
    } else {
      if (url.search || request.headers.get('origin') !== c.origin ||
          (request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded')
        return response('Invalid connection link.', 403);
      const reader = request.body?.getReader();
      if (!reader) return response('Invalid connection link.', 400);
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) { await reader.cancel(); return response('Invalid connection link.', 400); }
        chunks.push(value);
      }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const hasTicket = fields.getAll('ticket').length === 1 && fields.has('ticket');
      const hasCode = fields.getAll('code').length === 1 && fields.has('code');
      const allowedFields = hasTicket ? ['ticket', 'confirm'] : ['code', 'confirm'];
      if (hasTicket === hasCode || fields.getAll('confirm').length !== 1 ||
          fields.get('confirm') !== 'check_once' ||
          [...fields.keys()].some(key => !allowedFields.includes(key)))
        return response('Invalid connection link.', 400);
      if (hasTicket) ticket = fields.get('ticket');
      else code = fields.get('code');
    }
    if (ticket !== undefined) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || '')) return response('Invalid connection link.', 400);
      consentKey = 'partner-key-check-ticket:' + hash(ticket);
    } else {
      if (!/^[A-Za-z0-9_-]{12}$/.test(code || '')) return response('Invalid connection link.', 400);
      consentKey = 'partner-key-check-code:' + hash(code);
    }
    const sealed = await store.get(consentKey);
    if (!sealed) return response('The link expired or was already used. No check was sent.', 410);
    let consent;
    try { consent = unseal(sealed, c.key, consentKey); }
    catch { return response('Invalid connection link.', 400); }
    if (typeof consent.subject !== 'string' || !consent.subject || consent.subject.length > 512 ||
        !/^[a-f0-9]{64}$/.test(consent.fingerprint || '') ||
        !Number.isFinite(consent.expires) || consent.expires <= now())
      return response('The link expired or is invalid. No check was sent.', 410);
    if (request.method === 'GET') {
      const body = '<p>I will check with Tesla whether the domain <strong>' + configuredPartnerDomain(c.env) + '</strong> has registered the key matching fingerprint <code>' + consent.fingerprint + '</code>.</p><p>This read-only Tesla Partner check may use quota or incur Tesla service charges. It does not register the domain, read vehicle data, wake the vehicle, or send commands.</p><form method="post" action="' + path + '"><input type="hidden" name="ticket" value="' + ticket + '"><button type="submit" name="confirm" value="check_once">Authorize Tesla status check</button></form><p>To cancel, close this page without clicking the button.</p>';
      return html('Tesla registration check', body);
    }
    try {
      const status = await connectionStatus(consent.subject);
      if (!status.connected || status.vehicle_permissions.vehicle_commands !== true)
        return html('Check not performed', '<p>The Tesla account or permissions are no longer available. No request was sent.</p>');
      const identity = await readKeyPublic({ env: c.env, storeFactory: () => store });
      if (identity.sha256 !== consent.fingerprint)
        return html('Check not performed', '<p>The key has changed since this link was created. No Tesla request was sent.</p>');
      // Reserve both Tesla requests (Partner token + public-key lookup) before
      // consuming consent or making network calls. The checks above are local.
      const budgetReservation = await reserveTeslaRequest(2);
      const consumed = await store.take(consentKey);
      if (!consumed || consumed !== sealed || consent.expires <= now())
        return response('The link expired or was already used. No check was sent.', 410);
      const lookup = await partnerKeyLookup({ env: c.env, fetcher, approved: true, budgetReservation });
      if (lookup.found === true) {
        const matches = lookup.spki_sha256 === identity.sha256;
        const safe = { status: matches ? 'registered' : 'mismatch', key_matches: matches };
        await store.put(PARTNER_KEY_LOOKUP_RESULT_KEY, JSON.stringify(safe), 315360000);
        if (matches) {
          await store.put(PARTNER_REGISTER_RESULT_KEY, JSON.stringify({ registered: true, status: 200 }), 315360000);
          const pairingUrl = 'https://tesla.com/_ak/' + configuredPartnerDomain(c.env);
          return html('Key verified by Tesla', '<p>Tesla found the same public key registered for this domain.</p><p><a href="' + pairingUrl + '">Open Tesla and pair the key with the vehicle</a></p><p>No vehicle data was read and no command was sent.</p>');
        }
        return html('Key mismatch', '<p>The domain has a registered key that differs from the key stored by the backend. Do not pair the vehicle; technical verification is required.</p>');
      }
      if (lookup.found === false && ['not_found', 'partner_not_registered'].includes(lookup.status)) {
        await store.put(PARTNER_KEY_LOOKUP_RESULT_KEY, JSON.stringify({ status: 'not_found', key_matches: false }), 315360000);
        return html('Domain not registered', '<p>Tesla did not find a key registered for this domain. This check did not send a registration request.</p><p>Return to the chat and run <code>prepare_vehicle_command_setup</code>: you will receive a separate link to authorize one recovery attempt.</p>');
      }
      throw Error('partner_key_lookup_unavailable');
    } catch (err) {
      if (['budget', 'configuration', 'budget_store_unavailable'].includes(err?.message)) {
        console.info('TESLA_PARTNER_KEY_CHECK', 'budget_unavailable');
        return html('Check not performed', '<p>The daily quota or its counter is unavailable. No Tesla request was sent; the one-time code remains valid.</p>');
      }
      const allowed = new Set(['partner_key_check_not_approved', 'partner_key_check_configuration',
        'partner_key_budget_unavailable',
        'partner_auth_failed', 'partner_key_http_403', 'partner_key_http_406',
        'partner_key_http_412', 'partner_key_lookup_unavailable',
        'partner_key_response_json_unverified', 'partner_key_response_field_unverified',
        'partner_key_response_encoding_unverified', 'partner_key_response_curve_unverified',
        'partner_key_response_key_unverified']);
      const code = allowed.has(err?.message) ? err.message : 'partner_key_lookup_unavailable';
      console.info('TESLA_PARTNER_KEY_CHECK', code);
      if (['partner_key_response_encoding_unverified', 'partner_key_response_curve_unverified'].includes(code) &&
          ['empty', 'hex', 'pem', 'base64', 'other'].includes(err?.publicKeyShape) &&
          Number.isInteger(err?.publicKeyLength) && err.publicKeyLength >= 0 && err.publicKeyLength <= 8192) {
        console.info('TESLA_PARTNER_KEY_SHAPE', err.publicKeyShape, err.publicKeyLength);
      }
      return html('Result unavailable', '<p>Tesla did not return a verifiable status. No registration, vehicle read, or command was started.</p><p>Codice: <code>' + code + '</code>. Share only this code when requesting support.</p>');
    }
  }
  async function partnerRegistration(request) {
    if (!['GET', 'POST'].includes(request.method)) return response('', 405, { allow: 'GET, POST' });
    const url = new URL(request.url);
    const path = '/oauth/tesla/partner-registration';
    if (url.origin !== c.origin || url.pathname !== path) return response('Invalid connection link.', 404);
    let ticket;
    if (request.method === 'GET') {
      ticket = ticketFromBrowserUrl(url);
      if (!ticket) return response('Invalid connection link.', 400);
    } else {
      if (url.search || request.headers.get('origin') !== c.origin ||
          (request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded')
        return response('Invalid connection link.', 403);
      const reader = request.body?.getReader();
      if (!reader) return response('Invalid connection link.', 400);
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) { await reader.cancel(); return response('Invalid connection link.', 400); }
        chunks.push(value);
      }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (fields.getAll('ticket').length !== 1 || fields.getAll('confirm').length !== 1 ||
          fields.get('confirm') !== 'register_once' ||
          [...fields.keys()].some(key => key !== 'ticket' && key !== 'confirm'))
        return response('Invalid connection link.', 400);
      ticket = fields.get('ticket');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || '')) return response('Invalid connection link.', 400);
    const ticketKey = 'partner-registration-ticket:' + hash(ticket);
    const sealed = request.method === 'GET' ? await store.get(ticketKey) : await store.take(ticketKey);
    if (!sealed) return response('The link expired or was already used. No new request was sent.', 410);
    let consent;
    try { consent = unseal(sealed, c.key, ticketKey); }
    catch { return response('Invalid connection link.', 400); }
    if (typeof consent.subject !== 'string' || !consent.subject || consent.subject.length > 512 ||
        !/^[a-f0-9]{64}$/.test(consent.fingerprint || '') ||
        !Number.isFinite(consent.expires) || consent.expires <= now())
      return response('The link expired or is invalid. No new request was sent.', 410);

    const html = (title, body) => response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head><body><main><h1>' + title + '</h1>' + body + '</main></body></html>',
      200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; form-action 'self' https://tesla.com; base-uri 'none'; frame-ancestors 'none'" });
    if (request.method === 'GET') {
      console.info('TESLA_PARTNER_REGISTRATION', 'confirmation_viewed');
      const form = '<p>Domain to register: <strong>' + configuredPartnerDomain(c.env) + '</strong></p><p>SHA-256 fingerprint of the public key: <code>' + consent.fingerprint + '</code></p><p>This is a one-time request to the Tesla Partner service. It may incur charges and will not be repeated automatically. It does not read vehicle data, wake the vehicle, or send commands.</p><form method="post" action="' + path + '"><input type="hidden" name="ticket" value="' + ticket + '"><button type="submit" name="confirm" value="register_once">Authorize one Tesla registration request</button></form><p>To cancel, close this page without clicking the button.</p>';
      return html('Confirm Tesla registration', form);
    }

    console.info('TESLA_PARTNER_REGISTRATION', 'consent_consumed');
    let phase = 'preflight';
    try {
      const status = await connectionStatus(consent.subject);
      if (!status.connected || status.vehicle_permissions.vehicle_commands !== true)
        return html('Registration not started', '<p>The Tesla account or required permission is no longer available. No registration request was sent. Check the account status before generating a new link.</p>');
      const identity = await readKeyPublic({ env: c.env, storeFactory: () => store });
      if (identity.sha256 !== consent.fingerprint)
        return html('Registration not started', '<p>The virtual key changed after confirmation. No registration request was sent. Start setup again.</p>');
      phase = 'request';
      const result = await partnerRegistrar({ env: c.env, fetcher,
        storeFactory: () => store, approved: true, recovery: consent.recovery === true });
      const statusCode = Number.isInteger(result?.status) ? result.status : 0;
      const registered = result?.registered === true && statusCode >= 200 && statusCode < 300;
      const safeResult = { registered, status: statusCode,
        ...(typeof result?.trace === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(result.trace) ? { trace: result.trace } : {}) };
      phase = 'save_result';
      await store.put(PARTNER_REGISTER_RESULT_KEY, JSON.stringify(safeResult), 315360000);
      if (registered) {
        const pairingUrl = 'https://tesla.com/_ak/' + configuredPartnerDomain(c.env);
        console.info('TESLA_PARTNER_REGISTRATION', 'registered');
        return html('Domain registered by Tesla', '<p>Tesla confirmed domain registration. You can now pair the virtual key with your vehicle using the official link. This step did not send vehicle commands.</p><p><a href="' + pairingUrl + '">Open Tesla and pair the virtual key</a></p>');
      }
      console.info('TESLA_PARTNER_REGISTRATION', 'provider_rejected');
      return html('Tesla did not confirm registration', '<p>Tesla returned HTTP status ' + statusCode + '. The attempt was recorded and will not be repeated automatically. Do not use the pairing link; check Tesla Partner status.</p>');
    } catch (err) {
      const known = new Set(['partner_registration_not_approved', 'partner_public_key_not_ready',
        'partner_public_key_not_hosted', 'partner_public_key_mismatch',
        'partner_registration_reservation_failed', 'partner_registration_already_reserved',
        'partner_registration_recovery_not_verified',
        'partner_registration_token_failed', 'partner_registration_network_unverified']);
      const code = known.has(err?.message) ? err.message : 'other';
      console.info('TESLA_PARTNER_REGISTRATION', code);
      const noExternalCall = phase === 'preflight' || ['partner_registration_not_approved',
        'partner_public_key_not_ready', 'partner_public_key_not_hosted',
        'partner_public_key_mismatch', 'partner_registration_reservation_failed'].includes(code);
      const message = noExternalCall
        ? 'Preflight checks failed; no Tesla registration request was sent. Start setup again only after correcting the configuration.'
        : 'The one-time attempt was consumed, but its outcome cannot be verified. Do not repeat the request; first check the domain status in the Tesla portal.';
      return html('Registration result unavailable', '<p>' + message + '</p>');
    }
  }
  // The user's browser consumes the ticket, receives its own browser-bound
  // cookie and is redirected to official Tesla OAuth. No separate dashboard.
  async function launch(request) {
    if (!['GET', 'POST'].includes(request.method)) return response('', 405, {allow:'GET, POST'});
    const url = new URL(request.url);
    // ChatGPT may append its attribution parameter to outbound links. Accept
    // only that exact optional value; tickets and all other parameters remain strict.
    const params = url.searchParams;
    if (url.origin !== c.origin || url.pathname !== '/oauth/tesla/launch')
      return response('Invalid connection link.', 400);
    let ticket;
    if (request.method === 'GET') {
      ticket = ticketFromBrowserUrl(url);
      if (!ticket) return response('Invalid connection link.', 400);
    } else {
      // Only an explicit same-origin form submission may consume the ticket.
      if (url.search || request.headers.get('origin') !== c.origin ||
          (request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded')
        return response('Invalid connection link.', 403);
      const reader = request.body?.getReader();
      if (!reader) return response('Invalid connection link.', 400);
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) { await reader.cancel(); return response('Invalid connection link.', 400); }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const fields = new URLSearchParams(body);
      if (fields.getAll('ticket').length !== 1 || [...fields.keys()].some(key => key !== 'ticket'))
        return response('Invalid connection link.', 400);
      ticket = fields.get('ticket');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || ''))
      return response('Invalid connection link.', 400);
    const key = 'connect-ticket:' + hash(ticket);
    // GET is non-consuming, so link previews cannot spend a one-use ticket.
    const saved = request.method === 'GET' ? await store.get(key) : await store.take(key);
    if (!saved) {
      console.info('TESLA_HANDOFF_EVENT', 'ticket_unavailable');
      return response('The link expired or was already used.', 410);
    }
    let tx;
    try { tx = unseal(saved, c.key, key); }
    catch { return response('Invalid connection link.', 400); }
    if (typeof tx.subject !== 'string' || !tx.subject ||
        !Number.isFinite(tx.expires) || tx.expires <= now()) {
      console.info('TESLA_HANDOFF_EVENT', 'ticket_expired_or_invalid');
      return response('The link expired.', 410);
    }
    if (request.method === 'GET') {
      console.info('TESLA_HANDOFF_EVENT', 'confirmation_viewed');
      const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Tesla</title></head><body><main><h1>Connect your Tesla account</h1><p>Continue to the official Tesla website to authorize the connection.</p><form method="post" action="/oauth/tesla/launch"><input type="hidden" name="ticket" value="' + ticket + '"><button type="submit">Continue with Tesla</button></form></main></body></html>';
      // Browsers send Origin: null for form POSTs under no-referrer. Expose only
      // the origin (never the ticket-bearing URL) so the CSRF origin check works.
      // Browsers apply form-action to redirects too: allow only the local form
      // and the official Tesla authorization origin reached by its 303.
      return response(html, 200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'origin', 'content-security-policy': "default-src 'none'; form-action 'self' https://auth.tesla.com; base-uri 'none'; frame-ancestors 'none'" });
    }
    console.info('TESLA_HANDOFF_EVENT', 'ticket_consumed');
    const flow = await createBrowserOAuth(tx.subject);
    return new Response(null, {
      status: 303,
      headers: {
        ...headers, location: flow.authorizationUrl,
        'set-cookie': flow.cookie
      }
    });
  }
  async function callback(request) {
    if (request.method !== 'GET') return response('', 405, { allow: 'GET' });
    const url = new URL(request.url), clear = { 'set-cookie': `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` };
    // Log only fixed failure categories; never log state, codes, cookies or URLs.
    const reject = reason => {
      console.info('TESLA_CALLBACK_REJECT', reason);
      return response('Tesla connection failed. Start the connection flow again.', 400, clear);
    };
    const state = url.searchParams.get('state');
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) return reject('invalid_state_format');
    if ([...url.searchParams.keys()].some(k => !['state', 'code', 'error', 'error_description', 'error_uri', 'iss', 'issuer'].includes(k))) return reject('unexpected_parameter');
    if ([...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) return reject('duplicate_parameter');
    const cookies = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
    if (cookies.length !== 1) return reject('cookie_missing_or_multiple');
    const browser = cookies[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(browser)) return reject('invalid_cookie_format');
    const key = 'oauth:' + hash(state), saved = await store.get(key);
    if (!saved) return reject('state_not_found');
    const tx = unseal(saved, c.key, key);
    if (tx.browser !== hash(browser)) return reject('browser_mismatch');
    if (tx.expires <= now()) return reject('state_expired');
    // Atomic one-use consumption across serverless workers, after browser binding.
    if (await store.take(key) !== saved) return reject('state_already_consumed');
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error')) return reject('provider_error');
    if (typeof code !== 'string' || !code || code.length > 4096) return reject('invalid_code');
    if (url.searchParams.has('iss') && url.searchParams.has('issuer')) return reject('issuer_ambiguous');
    if (['iss', 'issuer'].some(name => url.searchParams.has(name) && url.searchParams.get(name) !== 'https://auth.tesla.com/oauth2/v3')) return reject('issuer_mismatch');
    try {
      await withTokens(tx.subject, async (key, lock) => {
        console.info('TESLA_OAUTH_STAGE', 'lock_acquired');
        // Tesla documents an optional scope parameter for code exchange.
        // Explicitly request the same scopes shown during authorization.
        const tokens = await exchange({ grant_type: 'authorization_code', client_secret: c.env.TESLA_CLIENT_SECRET, audience: c.fleet, redirect_uri: c.callback, scope: SCOPES.join(' '), code, code_verifier: tx.verifier });
        console.info('TESLA_OAUTH_STAGE', 'token_validated');
        await lock.save(seal(tokens, c.key, key), TTL);
        console.info('TESLA_OAUTH_STAGE', 'token_saved');
      });
      return response('Tesla connected. No vehicle data was read.', 200, clear);
    } catch (err) {
      const allowed = new Set(['budget', 'configuration', 'store', 'busy', 'upstream', 'reauthorize']);
      console.info('TESLA_OAUTH_FAILURE', allowed.has(err?.message) ? err.message : 'other');
      return response('Tesla connection is unavailable. Try again with a new authorization.', 503, clear);
    }
  }
  async function prepareVehicleRead(subject, requiredScope = 'vehicle_device_data') {
    if (c.env.TESLA_READ_ENABLED !== 'true') throw Error('disabled');
    const vin = c.env.TESLA_VEHICLE_VIN;
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin || '')) throw Error('configuration');
    // Reads run on demand without an application cooldown. The shared daily
    // ceiling, token lease and upstream Tesla limits still apply.
    if (!Number.isInteger(effectiveTeslaRequestLimit(c.env, now())) && effectiveTeslaRequestLimit(c.env, now()) !== Infinity) throw Error('configuration');
    const access = await withTokens(subject, async (key, lock) => {
      const encrypted = await store.get(key);
      if (!encrypted) throw Error('reauthorize');
      let tokens = unseal(encrypted, c.key, key);
      if (tokens.invalid || tokens.refreshExpires <= now()) throw Error('reauthorize');
      const currentScopes = Array.isArray(tokens.scopes) ? tokens.scopes : teslaTokenScopes(tokens.access);
      if (!Array.isArray(currentScopes) || !currentScopes.includes(requiredScope)) throw Error('permission');
      if (tokens.expires <= now() + 60000) {
        // Reserve before invalidating: an exhausted budget must not destroy a
        // still usable refresh token without sending any request to Tesla.
        await reserveTeslaRequest();
        // Persist a fail-closed marker BEFORE consuming a rotating refresh token.
        // A crash/timeout/failed save requires new consent, never a parallel/replayed refresh.
        await lock.save(seal({ invalid: true }, c.key, key), TTL);
        tokens = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh }, true);
        const refreshedScopes = Array.isArray(tokens.scopes) ? tokens.scopes : teslaTokenScopes(tokens.access);
        if (!Array.isArray(refreshedScopes) || !refreshedScopes.includes(requiredScope)) {
          await lock.save(seal({ invalid: true }, c.key, key), TTL);
          throw Error('permission');
        }
        await lock.save(seal(tokens, c.key, key), TTL);
      }
      return tokens.access;
    });
    return { vin, access };
  }
  async function vehicleConnectivity(subject, kind = 'connectivity') {
    if (!['connectivity', 'mobile_access'].includes(kind)) throw Error('invalid_arguments');
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_device_data');
    await reserveTeslaRequest();
    const endpoint = kind === 'mobile_access' ? '/mobile_enabled' : '';
    const data = await jsonFetch(fetcher, `${c.fleet}/api/1/vehicles/${vin}${endpoint}`, {
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' }
    });
    const checked_at = new Date(now()).toISOString();
    if (kind === 'mobile_access') {
      if (typeof data.response !== 'boolean') throw Error('upstream');
      return { source: 'TESLA_MOBILE_ACCESS', mobile_access_enabled: data.response, checked_at };
    }
    const state = data.response?.state;
    if (!['online', 'asleep', 'offline'].includes(state)) throw Error('upstream');
    return { source: 'TESLA_CONNECTIVITY', state, checked_at,
      note: 'Reachability status reported by Tesla at the time of the check; it may change before the next operation.' };
  }
  async function battery(subject, { live = false } = {}) {
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_device_data');
    // The default path returns Tesla's latest cached snapshot. The explicit
    // live path asks for the current vehicle blocks once, without fallback.
    await reserveTeslaRequest();
    const url = new URL(`${c.fleet}/api/1/vehicles/${vin}/${live ? 'vehicle_data' : 'vehicle_data_cached'}`);
    if (live) url.searchParams.set('endpoints', 'charge_state;climate_state;vehicle_state');
    // Tesla Fleet API requires Content-Type application/json even on GET.
    const observeResponse = async (requestUrl, options) => {
      const reply = await fetcher(requestUrl, options);
      console.info('TESLA_VEHICLE_READ_STATUS', live ? 'live' : 'cached', reply.status);
      return reply;
    };
    const data = await jsonFetch(observeResponse, url.href, { headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' } },
      live ? { 408: 'vehicle_unavailable' } : { 404: 'cache_unavailable', 412: 'cache_unsupported' });
    const state = data.response?.charge_state;
    if (!Number.isInteger(state?.battery_level) || state.battery_level < 0 || state.battery_level > 100 || !Number.isFinite(state.timestamp) || state.timestamp <= 0 || state.timestamp > now() + 60000) throw Error('upstream');
    const result = { source: live ? 'TESLA_LIVE' : 'TESLA_CACHED', battery_percent: state.battery_level,
      observed_at: new Date(state.timestamp).toISOString(),
      note: live
        ? 'Data was requested from Tesla now. If the vehicle is unreachable, the read stops without falling back to cache, explicitly calling wake_up, or retrying.'
        : 'Latest data already available from Tesla; it may be stale. The timestamp shows when Tesla recorded the state.' };
    // Tesla may omit individual cached fields. Return only a small explicit
    // allowlist; never relay the response, vehicle identifiers or location.
    if (Number.isFinite(state.battery_range) && state.battery_range >= 0 && state.battery_range <= 1000)
      result.estimated_range_miles = state.battery_range;
    if (Number.isFinite(state.est_battery_range) && state.est_battery_range >= 0 && state.est_battery_range <= 1000)
      result.estimated_range_typical_miles = state.est_battery_range;
    if (Number.isFinite(state.ideal_battery_range) && state.ideal_battery_range >= 0 && state.ideal_battery_range <= 1000)
      result.ideal_range_miles = state.ideal_battery_range;
    if (Number.isInteger(state.charge_limit_soc) && state.charge_limit_soc >= 0 && state.charge_limit_soc <= 100)
      result.charge_limit_percent = state.charge_limit_soc;
    if (['Disconnected', 'NoPower', 'Starting', 'Charging', 'Complete', 'Stopped'].includes(state.charging_state))
      result.charging_state = state.charging_state;
    if (Number.isFinite(state.charge_energy_added) && state.charge_energy_added >= 0 && state.charge_energy_added <= 1000)
      result.charge_energy_added_kwh = state.charge_energy_added;
    if (Number.isFinite(state.charger_power) && state.charger_power >= 0 && state.charger_power <= 500)
      result.charger_power_kw = state.charger_power;
    if (Number.isInteger(state.charger_voltage) && state.charger_voltage >= 0 && state.charger_voltage <= 1000)
      result.charger_voltage = state.charger_voltage;
    if (Number.isInteger(state.charger_actual_current) && state.charger_actual_current >= 0 && state.charger_actual_current <= 1000)
      result.charger_current_amps = state.charger_actual_current;
    if (Number.isFinite(state.time_to_full_charge) && state.time_to_full_charge >= 0 && state.time_to_full_charge <= 100)
      result.hours_to_full_charge = state.time_to_full_charge;
    if (Number.isFinite(state.charge_rate) && state.charge_rate >= 0 && state.charge_rate <= 1000)
      result.charge_rate_miles_per_hour = state.charge_rate;
    for (const [source, target] of [['battery_heater_on','battery_heater_on'],['preconditioning_enabled','preconditioning_enabled'],['scheduled_charging_pending','scheduled_charging_pending'],['trip_charging','trip_charging'],['supercharger_session_trip_planner','supercharger_session_trip_planner']])
      if (typeof state[source] === 'boolean') result[target] = state[source];
    if (Number.isFinite(state.scheduled_charging_start_time) && state.scheduled_charging_start_time > 0 && state.scheduled_charging_start_time <= now() + 86400000)
      result.scheduled_charging_start_time = new Date(state.scheduled_charging_start_time).toISOString();
    const vehicle = data.response?.vehicle_state;
    const vehicleStatus = {};
    if (typeof vehicle?.locked === 'boolean') vehicleStatus.locked = vehicle.locked;
    if (typeof vehicle?.sentry_mode === 'boolean') vehicleStatus.sentry_mode = vehicle.sentry_mode;
    if (typeof vehicle?.valet_mode === 'boolean') vehicleStatus.valet_mode = vehicle.valet_mode;
    if (typeof vehicle?.service_mode === 'boolean') vehicleStatus.service_mode = vehicle.service_mode;
    if (typeof vehicle?.remote_start_enabled === 'boolean') vehicleStatus.remote_start_enabled = vehicle.remote_start_enabled;
    if (typeof vehicle?.speed_limit_mode === 'boolean') vehicleStatus.speed_limit_mode = vehicle.speed_limit_mode;
    for (const field of ['fd_window','fp_window','rd_window','rp_window'])
      if (typeof vehicle?.[field] === 'string' && vehicle[field].length <= 32)
        (vehicleStatus.windows ||= {})[field] = vehicle[field];
    if (Number.isFinite(vehicle?.odometer) && vehicle.odometer >= 0 && vehicle.odometer <= 2000000)
      vehicleStatus.odometer_miles = vehicle.odometer;
    if (typeof vehicle?.car_version === 'string' && vehicle.car_version.length <= 64)
      vehicleStatus.software_version = vehicle.car_version;
    if (vehicle?.software_update && typeof vehicle.software_update === 'object') {
      const update = {};
      if (typeof vehicle.software_update.status === 'string' && vehicle.software_update.status.length <= 40)
        update.status = vehicle.software_update.status;
      if (typeof vehicle.software_update.version === 'string' && vehicle.software_update.version.length <= 64)
        update.version = vehicle.software_update.version;
      for (const field of ['download_perc','install_perc'])
        if (Number.isInteger(vehicle.software_update[field]) && vehicle.software_update[field] >= 0 && vehicle.software_update[field] <= 100)
          update[field] = vehicle.software_update[field];
      if (Number.isFinite(vehicle.software_update.expected_duration_sec) && vehicle.software_update.expected_duration_sec >= 0 && vehicle.software_update.expected_duration_sec <= 86400)
        update.expected_duration_seconds = vehicle.software_update.expected_duration_sec;
      if (Object.keys(update).length) vehicleStatus.software_update = update;
    }
    const pressures = {};
    for (const corner of ['fl','fr','rl','rr']) {
      const value = vehicle?.[`tpms_pressure_${corner}`];
      if (Number.isFinite(value) && value >= 0 && value <= 10) pressures[corner] = value;
    }
    if (Object.keys(pressures).length) vehicleStatus.tire_pressure_bar = pressures;
    for (const field of ['tpms_soft_warning_fl','tpms_soft_warning_fr','tpms_soft_warning_rl','tpms_soft_warning_rr','tpms_hard_warning_fl','tpms_hard_warning_fr','tpms_hard_warning_rl','tpms_hard_warning_rr'])
      if (typeof vehicle?.[field] === 'boolean') (vehicleStatus.tire_warnings ||= {})[field] = vehicle[field];
    if (Number.isFinite(vehicle?.timestamp) && vehicle.timestamp > 0 && vehicle.timestamp <= now() + 60000)
      vehicleStatus.observed_at = new Date(vehicle.timestamp).toISOString();
    if (Object.keys(vehicleStatus).length) result.vehicle_status = vehicleStatus;
    const climate = data.response?.climate_state;
    const cabin = {};
    if (typeof climate?.is_climate_on === 'boolean') cabin.climate_on = climate.is_climate_on;
    if (Number.isFinite(climate?.inside_temp) && climate.inside_temp >= -50 && climate.inside_temp <= 80)
      cabin.inside_temperature_c = climate.inside_temp;
    if (Number.isFinite(climate?.outside_temp) && climate.outside_temp >= -50 && climate.outside_temp <= 80)
      cabin.outside_temperature_c = climate.outside_temp;
    if (Number.isFinite(climate?.driver_temp_setting) && climate.driver_temp_setting >= 10 && climate.driver_temp_setting <= 40)
      cabin.driver_target_temperature_c = climate.driver_temp_setting;
    if (Number.isFinite(climate?.passenger_temp_setting) && climate.passenger_temp_setting >= 10 && climate.passenger_temp_setting <= 40)
      cabin.passenger_target_temperature_c = climate.passenger_temp_setting;
    if (Number.isInteger(climate?.seat_heater_left) && climate.seat_heater_left >= 0 && climate.seat_heater_left <= 3)
      cabin.driver_seat_heater_level = climate.seat_heater_left;
    if (Number.isInteger(climate?.seat_heater_right) && climate.seat_heater_right >= 0 && climate.seat_heater_right <= 3)
      cabin.passenger_seat_heater_level = climate.seat_heater_right;
    if (Number.isInteger(climate?.steering_wheel_heater) && [0, 1].includes(climate.steering_wheel_heater))
      cabin.steering_wheel_heater_on = climate.steering_wheel_heater === 1;
    if (Number.isInteger(climate?.steering_wheel_heat_level) && climate.steering_wheel_heat_level >= 0 && climate.steering_wheel_heat_level <= 3)
      cabin.steering_wheel_heat_level = climate.steering_wheel_heat_level;
    for (const field of ['seat_heater_rear_left','seat_heater_rear_center','seat_heater_rear_right'])
      if (Number.isInteger(climate?.[field]) && climate[field] >= 0 && climate[field] <= 3) cabin[field] = climate[field];
    if (typeof climate?.wiper_heater === 'boolean') cabin.wiper_heater_on = climate.wiper_heater;
    if (Number.isInteger(climate?.climate_keeper_mode) && climate.climate_keeper_mode >= 0 && climate.climate_keeper_mode <= 3)
      cabin.climate_keeper_mode = climate.climate_keeper_mode;
    if (Number.isFinite(climate?.timestamp) && climate.timestamp > 0 && climate.timestamp <= now() + 60000)
      cabin.observed_at = new Date(climate.timestamp).toISOString();
    if (Object.keys(cabin).length) result.climate = cabin;
    result.history_recorded = await recordVehicleReading(subject, result);
    return result;
  }
  async function recordVehicleReading(subject, reading) {
    const key = 'vehicle-reading-history:' + hash(c.issuer + '\n' + subject);
    let lock;
    try {
      lock = await store.lock(key);
      const encrypted = await store.get(key);
      let records = [];
      if (encrypted) {
        const saved = unseal(encrypted, c.key, key);
        if (!Array.isArray(saved)) throw Error('store');
        records = saved.filter(item => item && typeof item.requested_at === 'string' &&
          Number.isFinite(Date.parse(item.requested_at)) && Date.parse(item.requested_at) >= now() - 31 * 86400000);
      }
      const record = { source: reading.source, requested_at: new Date(now()).toISOString(), observed_at: reading.observed_at,
        battery_percent: reading.battery_percent };
      for (const field of ['estimated_range_miles','estimated_range_typical_miles','ideal_range_miles','charge_limit_percent',
        'charging_state','charge_energy_added_kwh','charger_power_kw','charger_voltage','charger_current_amps',
        'hours_to_full_charge','charge_rate_miles_per_hour'])
        if (Object.hasOwn(reading, field)) record[field] = reading[field];
      if (reading.vehicle_status) record.vehicle_status = reading.vehicle_status;
      if (reading.climate) record.climate = reading.climate;
      const next = [...records, record].slice(-100);
      await lock.save(seal(next, c.key, key), 31 * 86400);
      return true;
    } catch {
      return false;
    } finally {
      if (lock) await lock.release().catch(() => {});
    }
  }
  async function vehicleReadingHistory(subject, days = 30) {
    if (!Number.isInteger(days) || days < 1 || days > 31) throw Error('invalid_arguments');
    const key = 'vehicle-reading-history:' + hash(c.issuer + '\n' + subject);
    const encrypted = await store.get(key);
    if (!encrypted) return { source: 'APP_READING_HISTORY', period_days: days, readings: [],
      note: 'Application history is empty. Samples are collected when Tesla data is requested.' };
    let records;
    try { records = unseal(encrypted, c.key, key); } catch { throw Error('store'); }
    if (!Array.isArray(records)) throw Error('store');
    const cutoff = now() - days * 86400000;
    return { source: 'APP_READING_HISTORY', period_days: days,
      readings: records.filter(item => item && Date.parse(item.requested_at) >= cutoff).slice(-100),
      note: 'On-demand application samples, ordered by collection time; each entry also retains the Tesla data timestamp.' };
  }
  async function vehicleSchedules(subject) {
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_device_data');
    await reserveTeslaRequest();
    const url = new URL(`${c.fleet}/api/1/vehicles/${vin}/vehicle_data`);
    url.searchParams.set('endpoints', 'charge_schedule_data;preconditioning_schedule_data');
    const data = await jsonFetch(observeReadStatus('vehicle_schedules'), url.href, {
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' }
    }, { 408: 'vehicle_unavailable' });
    const project = (section, listName, fields) => {
      const entries = Array.isArray(section) ? section : [listName, 'schedules'].map(key => section?.[key]).find(Array.isArray);
      if (!Array.isArray(entries)) return { available: false, schedules: [], omitted_entries: 0 };
      let omittedEntries = 0;
      const schedules = entries.slice(0, 20).flatMap(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          omittedEntries++;
          return [];
        }
        const result = {};
        for (const field of fields) {
          const value = entry[field];
          if (field === 'id' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) result.id = value;
          else if (['enabled','one_time','start_enabled','end_enabled'].includes(field) && typeof value === 'boolean') result[field] = value;
          else if (field === 'days_of_week' && typeof value === 'string' && value.length <= 80) result.days_of_week = value;
          else if (['start_time','end_time','precondition_time'].includes(field) && Number.isInteger(value) && value >= 0 && value <= 1439) result[field] = value;
        }
        if (Object.keys(result).length) return [result];
        omittedEntries++;
        return [];
      });
      return { available: true, schedules, omitted_entries: omittedEntries + Math.max(0, entries.length - 20) };
    };
    const response = data.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw Error('upstream');
    return {
      source: 'TESLA_SCHEDULES_LIVE',
      checked_at: new Date(now()).toISOString(),
      charging: project(response.charge_schedule_data, 'charge_schedules', ['id','enabled','one_time','days_of_week','start_time','start_enabled','end_time','end_enabled']),
      preconditioning: project(response.preconditioning_schedule_data, 'preconditioning_schedules', ['id','enabled','one_time','days_of_week','precondition_time']),
      note: 'Native schedules reported by the vehicle. Times use the vehicle’s local time zone; place coordinates are not returned. If available is false, Tesla did not return an interpretable list; this does not mean that no schedules are configured. On-demand read; no automatic monitoring.'
    };
  }
  // Exposed only with the separate MCP location scope and explicit server flag.
  // This live read is not retried and never invokes wake_up.
  async function location(subject, reservePercent = undefined) {
    if (c.env.TESLA_LOCATION_ENABLED !== 'true') throw Error('disabled');
    if (reservePercent !== undefined && (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 100))
      throw Error('invalid_arguments');
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_location');
    await reserveTeslaRequest();
    const url = new URL(`${c.fleet}/api/1/vehicles/${vin}/vehicle_data`);
    url.searchParams.set('endpoints', 'location_data');
    const data = await jsonFetch(observeReadStatus('location'), url.href, { headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' } }, { 408: 'vehicle_unavailable' });
    const state = data.response?.drive_state;
    if (!Number.isFinite(state?.latitude) || state.latitude < -90 || state.latitude > 90 ||
        !Number.isFinite(state?.longitude) || state.longitude < -180 || state.longitude > 180 ||
        !Number.isFinite(state?.timestamp) || state.timestamp <= 0 || state.timestamp > now() + 60000) {
      console.info('TESLA_READ_RESPONSE_INVALID', 'location');
      throw Error('upstream');
    }
    const result = { source: 'TESLA_LIVE', latitude: state.latitude, longitude: state.longitude,
      observed_at: new Date(state.timestamp).toISOString(), checked_at: new Date(now()).toISOString(),
      data_age_seconds: Math.max(0, Math.floor((now() - state.timestamp) / 1000)) };
    const navigation = {};
    if (typeof state.active_route_destination === 'string' && state.active_route_destination.trim() && state.active_route_destination.length <= 120)
      navigation.destination = state.active_route_destination.trim();
    if (Number.isInteger(state.active_route_energy_at_arrival) && state.active_route_energy_at_arrival >= 0 && state.active_route_energy_at_arrival <= 100)
      navigation.expected_arrival_battery_percent = state.active_route_energy_at_arrival;
    if (Number.isFinite(state.active_route_miles_to_arrival) && state.active_route_miles_to_arrival >= 0 && state.active_route_miles_to_arrival <= 10000)
      navigation.distance_to_arrival_km = Math.round(state.active_route_miles_to_arrival * 1.609344 * 10) / 10;
    if (Number.isFinite(state.active_route_minutes_to_arrival) && state.active_route_minutes_to_arrival >= 0 && state.active_route_minutes_to_arrival <= 10080)
      navigation.eta_minutes = Math.round(state.active_route_minutes_to_arrival * 10) / 10;
    if (Number.isFinite(state.active_route_traffic_minutes_delay) && state.active_route_traffic_minutes_delay >= 0 && state.active_route_traffic_minutes_delay <= 1440)
      navigation.traffic_delay_minutes = Math.round(state.active_route_traffic_minutes_delay * 10) / 10;
    if (Object.keys(navigation).length) result.navigation = navigation;
    if (reservePercent !== undefined) {
      const arrivalPercent = navigation.expected_arrival_battery_percent;
      result.route_reserve_assessment = Number.isInteger(arrivalPercent)
        ? { available: true, reserve_percent: reservePercent, expected_arrival_battery_percent: arrivalPercent,
            meets_reserve: arrivalPercent >= reservePercent,
            shortfall_percentage_points: Math.max(0, reservePercent - arrivalPercent) }
        : { available: false, reserve_percent: reservePercent,
            note: 'Tesla did not provide an estimated arrival battery percentage for an active route.' };
    }
    return result;
  }
  function logNearbyDiagnostic(status, errorClass) {
    const messages = {
      http_error: 'Tesla returned an HTTP error.',
      timeout: 'The Tesla request timed out.',
      network_error: 'No HTTP response was received from the provider.',
      invalid_response: 'The provider response is unusable.'
    };
    if (!Object.hasOwn(messages, errorClass)) return;
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    try {
      logger.error('TESLA_NEARBY_DIAGNOSTIC', JSON.stringify({
        http_status: safeStatus,
        error_class: errorClass,
        message: messages[errorClass]
      }));
    } catch {}
  }
  async function nearbyChargingSites(subject) {
    if (c.env.TESLA_LOCATION_ENABLED !== 'true') throw Error('disabled');
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_location');
    await reserveTeslaRequest();
    let httpStatus = null;
    const observedFetch = async (...args) => {
      const response = await fetcher(...args);
      if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) {
        httpStatus = response.status;
      }
      return response;
    };
    let data;
    try {
      data = await jsonFetch(observedFetch, `${c.fleet}/api/1/vehicles/${vin}/nearby_charging_sites?detail=true`, {
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' }
      });
    } catch (error) {
      if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
        logNearbyDiagnostic(httpStatus, 'http_error');
      } else if (httpStatus === null && ['TimeoutError', 'AbortError'].includes(error?.name)) {
        logNearbyDiagnostic(null, 'timeout');
      } else if (httpStatus === null) {
        logNearbyDiagnostic(null, 'network_error');
      } else {
        logNearbyDiagnostic(httpStatus, 'invalid_response');
      }
      throw error;
    }
    const response = data?.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      logNearbyDiagnostic(httpStatus, 'invalid_response');
      throw Error('upstream');
    }
    const projectSites = (sites, kind) => Array.isArray(sites) ? sites.slice(0, 20).flatMap(site => {
      if (!site || typeof site !== 'object' || Array.isArray(site)) return [];
      const result = { kind };
      // Preserve a Tesla-provided identity only; never reinterpret EVSE/OSM IDs.
      const siteId=typeof site.id==='number'&&Number.isSafeInteger(site.id)&&site.id>0?String(site.id):typeof site.id==='string'&&/^[1-9][0-9]{0,18}$/.test(site.id)?site.id:null;
      if(kind==='supercharger'&&siteId&&BigInt(siteId)<=9223372036854775807n){result.tesla_site_id=siteId;result.tesla_site_id_source='TESLA_NEARBY_CHARGING_SITES';}

      if (typeof site.name === 'string' && site.name.trim() && site.name.length <= 120) result.name = site.name.trim();
      if (typeof site.type === 'string' && site.type.length <= 40) result.type = site.type;
      if (Number.isFinite(site.distance_miles) && site.distance_miles >= 0 && site.distance_miles <= 10000) result.distance_miles = site.distance_miles;
      if (Number.isInteger(site.available_stalls) && site.available_stalls >= 0 && site.available_stalls <= 10000) result.available_stalls = site.available_stalls;
      if (Number.isInteger(site.total_stalls) && site.total_stalls >= 0 && site.total_stalls <= 10000) result.total_stalls = site.total_stalls;
      if (typeof site.site_closed === 'boolean') result.closed = site.site_closed;
      const point = site.location;
      if (point && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 &&
          Number.isFinite(point.long) && point.long >= -180 && point.long <= 180) {
        result.latitude = point.lat;
        result.longitude = point.long;
      }
      return Object.keys(result).length > 1 ? [result] : [];
    }) : [];
    const observed = response.congestion_sync_time_utc_secs;
    const result = {
      source: 'TESLA_NEARBY_CHARGING_SITES',
      observed_at: Number.isFinite(observed) && observed > 0 && observed <= now() / 1000 + 60
        ? new Date(observed * 1000).toISOString() : null,
      sites: [
        ...projectSites(response.superchargers, 'supercharger'),
        ...projectSites(response.destination_charging, 'destination_charger')
      ].slice(0, 40),
      note: 'Results returned by Tesla for the vehicle location; these are not a price list. On-demand request, not a cached read.'
    };
    if(nativeSuperchargerEnabled){try{result.native_selection_cache={ready:(await nativeSelections.remember(subject,result.sites))>0};}catch{result.native_selection_cache={ready:false,reason:'selection_storage_unavailable'};}}
    return result;
  }
  async function serviceHistory(subject, { page = 1, perPage = 20 } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100 ||
        !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 50) throw Error('invalid_arguments');
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_device_data');
    await reserveTeslaRequest();
    const url = new URL(`${c.fleet}/api/1/vehicles/${vin}/service_history`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    const data = await jsonFetch(observeReadStatus('service_history'), url.href, {
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' }
    });
    const result = data?.response;
    if (!result || !Array.isArray(result.service_visits)) throw Error('upstream');
    return { visits: result.service_visits.map(visit => ({
      service_visit_id: visit.service_visit_id,
      completed_at: visit.completed_at,
      status: visit.status,
      visit_type: visit.visit_type
    })), pagination: result.pagination ?? null, source: 'tesla_fleet_api', no_vehicle_wake: true };
  }
  async function serviceVisitDetails(subject, serviceVisitId) {
    if (typeof serviceVisitId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(serviceVisitId))
      throw Error('invalid_arguments');
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_device_data');
    await reserveTeslaRequest();
    const url = `${c.fleet}/api/1/vehicles/${vin}/service_history/${encodeURIComponent(serviceVisitId)}`;
    const data = await jsonFetch(observeReadStatus('service_visit_details'), url, {
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' }
    });
    const visit = data?.response;
    if (!visit || typeof visit !== 'object' || Array.isArray(visit)) throw Error('upstream');
    return {
      service_visit_id: visit.service_visit_id, completed_at: visit.completed_at,
      status: visit.status, visit_type: visit.visit_type,
      work_items: Array.isArray(visit.work_items) ? visit.work_items.map(item => ({
        correction_code: item.correction_code, description: item.description, pay_type: item.pay_type
      })) : [],
      cost: visit.cost ?? null, source: 'tesla_fleet_api', no_vehicle_wake: true
    };
  }
  async function chargingHistory(subject, days = 30) {
    if (!Number.isInteger(days) || days < 1 || days > 31) throw Error('invalid_arguments');
    const { vin, access } = await prepareVehicleRead(subject, 'vehicle_charging_cmds');
    await reserveTeslaRequest();
    const end = now();
    const url = new URL(`${c.fleet}/api/1/dx/charging/history`);
    url.searchParams.set('vin', vin);
    url.searchParams.set('startTime', new Date(end - days * 86400000).toISOString());
    url.searchParams.set('endTime', new Date(end).toISOString());
    url.searchParams.set('pageNo', '1');
    url.searchParams.set('pageSize', '10');
    const data = await jsonFetch(observeReadStatus('charging_history'), url.href, {
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json' }
    });
    const sessions = Array.isArray(data.data) ? data.data : data.response?.data;
    if (!Array.isArray(sessions)) {
      const safeKeys = value => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)).slice(0, 12)
        : [];
      console.info('TESLA_READ_RESPONSE_SHAPE', 'charging_history', JSON.stringify({
        top_level_keys: safeKeys(data),
        response_type: Array.isArray(data.response) ? 'array' : typeof data.response,
        response_keys: safeKeys(data.response),
        data_type: Array.isArray(data.response?.data) ? 'array' : typeof data.response?.data
      }));
      console.info('TESLA_READ_RESPONSE_INVALID', 'charging_history');
      throw Error('upstream');
    }
    const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
    const instant = value => {
      if (typeof value !== 'string' || value.length > 64) return undefined;
      const millis = Date.parse(value);
      return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
    };
    return {
      source: 'TESLA_CHARGING_HISTORY',
      period_days: days,
      sessions: sessions.slice(0, 10).flatMap(session => {
        if (!session || typeof session !== 'object' || Array.isArray(session)) return [];
        const item = {};
        const site = text(session.siteLocationName);
        const country = text(session.countryCode, 2);
        const started = instant(session.chargeStartDateTime);
        const stopped = instant(session.chargeStopDateTime);
        if (site) item.site_name = site;
        if (country && /^[A-Za-z]{2}$/.test(country)) item.country = country.toUpperCase();
        if (started) item.started_at = started;
        if (stopped) item.stopped_at = stopped;
        const billingType = text(session.billingType, 32);
        if (billingType) item.billing_type = billingType;
        if (Array.isArray(session.fees)) {
          item.fees = session.fees.slice(0, 8).flatMap(fee => {
            if (!fee || typeof fee !== 'object' || Array.isArray(fee)) return [];
            const feeType = text(fee.feeType, 32);
            const currency = text(fee.currencyCode, 3);
            const unit = text(fee.uom, 16);
            const amount = fee.totalDue;
            if (!feeType || !Number.isFinite(amount) || amount < 0 || amount > 100000) return [];
            const summary = { type: feeType, total_due: amount };
            if (currency && /^[A-Za-z]{3}$/.test(currency)) summary.currency = currency.toUpperCase();
            if (unit) summary.unit = unit;
            if (typeof fee.isPaid === 'boolean') summary.paid = fee.isPaid;
            const status = text(fee.status, 32);
            if (status) summary.status = status;
            return [summary];
          });
        }
        return Object.keys(item).length ? [item] : [];
      }),
      truncated: sessions.length >= 10,
      note: 'History returned by Tesla; this is not a live vehicle read. Vehicle identifiers and billing documents are omitted.'
    };
  }
  async function prepareCommand(subject, operation, args) {
    if (c.env.TESLA_COMMANDS_ENABLED !== 'true' || c.env.TESLA_COMMAND_EXECUTION_ENABLED !== 'true') throw Error('disabled');
    const vin = c.env.TESLA_VEHICLE_VIN;
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin || '')) throw Error('configuration');
    const plan = prepareOperation(operation,args,await commandOperationOptions(subject,operation,args));
    if(nativeMode(operation,args)==='experimental_native_supercharger')await nativeSelections.require(subject,args.site_id);
    const status = await connectionStatus(subject);
    if (!status.connected) throw Error('reauthorize');
    const permission = plan.tesla_scope === 'vehicle_charging_cmds'
      ? status.vehicle_permissions.charging_management : status.vehicle_permissions.vehicle_commands;
    if (permission !== true) throw Error('permission');
    await readStoredTeslaP256Private({ env: c.env, storeFactory: () => store });
    const prepared = await commandAuthorization.prepare(subject, hash(vin), operation, args);
    return { ...prepared, execution_enabled: true,
      note: 'Command prepared only. Sending it requires your separate confirmation with the exact phrase.' };
  }
  async function commandAccessToken(subject, requiredScope) {
    return withTokens(subject, async (key, lock) => {
      const encrypted = await store.get(key);
      if (!encrypted) throw Error('reauthorize');
      let tokens = unseal(encrypted, c.key, key);
      const scopes = Array.isArray(tokens.scopes) ? tokens.scopes : teslaTokenScopes(tokens.access);
      if (!Array.isArray(scopes) || !scopes.includes(requiredScope)) throw Error('permission');
      if (tokens.invalid || !Number.isFinite(tokens.refreshExpires) || tokens.refreshExpires <= now()) throw Error('reauthorize');
      if (!Number.isFinite(tokens.expires) || tokens.expires <= now() + 60000) {
        await reserveTeslaRequest();
        await lock.save(seal({ invalid: true }, c.key, key), TTL);
        tokens = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh }, true);
        const refreshedScopes = Array.isArray(tokens.scopes) ? tokens.scopes : teslaTokenScopes(tokens.access);
        if (!Array.isArray(refreshedScopes) || !refreshedScopes.includes(requiredScope)) {
          await lock.save(seal({ invalid: true }, c.key, key), TTL);
          throw Error('permission');
        }
        await lock.save(seal(tokens, c.key, key), TTL);
      }
      return tokens.access;
    });
  }
  async function confirmCommand(subject, ticket, confirmationPhrase, directPlan = null, beforeDispatch = async () => {}) {
    let stage = 'configuration';
    try {
    if (c.env.TESLA_COMMANDS_ENABLED !== 'true' || c.env.TESLA_COMMAND_EXECUTION_ENABLED !== 'true') throw Error('disabled');
    stage = 'confirmation';
    const confirmed = directPlan ?? await commandAuthorization.confirm(subject, ticket, confirmationPhrase);
    const gpsDiagnostic=confirmed.gpsDiagnostic??null;
    if (confirmed.vehicle_fingerprint !== hash(c.env.TESLA_VEHICLE_VIN || '')) throw Error('confirmation_context_mismatch');
    if (!directPlan) {
      const plan=prepareOperation(confirmed.operation,confirmed.args,await commandOperationOptions(subject,confirmed.operation,confirmed.args));
      const execute=executionBudget=>withNavigationFixtureFence(subject,plan,'confirmed:' + ticket,navigationFence=>lifecycle.execute(subject,plan,
        'confirmed:' + ticket, fence => confirmCommand(subject, null, null, {...confirmed,executionBudget,navigationGuardOwner:navigationFence?.owner,navigationGuardScope:navigationFence?.scope}, fence)));
      return boundedPlan(plan) ? withGPSExecutionBudget(execute) : execute();
    }
    const mode=nativeMode(confirmed.operation,confirmed.args);
    const needsBudget=confirmed.operation==='navigation_gps_request'&&gpsRouteExecutionEnabled||mode!==null;
    const executionBudget=needsBudget ? confirmed.executionBudget : null;
    if(needsBudget&&!executionBudget)throw Error('configuration');
    executionBudget?.assertActive();
    if(mode==='experimental_native_supercharger'){stage='station_selection';await nativeSelections.require(subject,confirmed.args.site_id);executionBudget.assertActive();}
    stage = 'identity';
    const identity = await readStoredTeslaP256Private({ env: c.env, storeFactory: () => store });
    executionBudget?.assertActive();
    stage = 'access_token';
    const requiredScope = prepareOperation(confirmed.operation,confirmed.args,
      await commandOperationOptions(subject,confirmed.operation,confirmed.args,false,gpsDiagnostic?.phase??null)).tesla_scope;
    const access = await commandAccessToken(subject, requiredScope);
    executionBudget?.assertActive();
    stage = 'envelope';
    const nonce = random();
    const payload = JSON.stringify({
      vin: c.env.TESLA_VEHICLE_VIN,
      operation: confirmed.operation,
      arguments: confirmed.args,
      access_token: access,
      private_key_pem: identity.privatePem,
      nonce,
      ...(gpsDiagnostic?{gps_diagnostic:gpsDiagnostic}:{}),
      ...(executionBudget?{route_deadline_unix_ms:executionBudget.deadlineMs,navigation_guard_owner:confirmed.navigationGuardOwner,
        ...(confirmed.navigationGuardScope?{navigation_guard_scope:confirmed.navigationGuardScope}:{})}: {})
    });
    const timestamp = String(now());
    const signingKey = createHmac('sha256', c.key).update('tesla-command-proxy-v1').digest();
    const signature = createHmac('sha256', signingKey).update(timestamp + '\n' + payload).digest('base64url');
    stage = 'budget';
    executionBudget?.assertActive();
    await reserveTeslaRequest(confirmed.operation==='navigation_gps_request'&&gpsRouteExecutionEnabled ? gpsDiagnostic?1:confirmed.args.points.length : 1);
    let coordinateRouteResult=null;
    try {
      stage = 'proxy_request';
      executionBudget?.assertActive();
      await beforeDispatch(nonce);
      executionBudget?.assertActive();
      const proxyFetch = confirmed.operation==='navigation_gps_request'&&gpsRouteFixtureEnabled ? gpsRouteProxyFixture : fetcher;
      const reply = await proxyFetch(c.origin + '/api/tesla-command-proxy', {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: executionBudget?.signal ?? AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', 'x-tesla-command-time': timestamp,
          'x-tesla-command-signature': signature }, body: payload
      });
      const body = await reply.json().catch(() => null);
      if (!reply.ok) {
        const known = new Set(['command_rejected','command_replayed','vehicle_unavailable','virtual_key_unpaired','command_budget_replayed','command_upstream_unavailable','command_outcome_unknown','diagnostic_session_unavailable','diagnostic_session_invalid']);
        const error = Error(known.has(body?.error) ? body.error : reply.status === 401 ? 'permission' : 'command_unavailable');
        error.definitiveNoEffect = body?.command_evidence?.definitive_no_effect === true;
        error.proxyAccepted = body?.command_evidence?.proxy_accepted === true;
        throw error;
      }
      if (body?.accepted !== true) throw Error('command_unavailable');
      if(gpsDiagnostic){
        if(body.navigation_mode!=='experimental_gps_diagnostic'||body.phase!==gpsDiagnostic.phase||body.session_id!==gpsDiagnostic.session_id||body.api_accepted!==true||body.vehicle_route_verified!==false||body.display_verified!==false||body.accepted_stops!==(gpsDiagnostic.phase==='replace'?1:2)||body.total_stops!==2)throw Error('command_outcome_unknown');
        coordinateRouteResult={navigation_mode:'experimental_gps_diagnostic',phase:gpsDiagnostic.phase,session_id:gpsDiagnostic.session_id,api_accepted:true,accepted_stops:body.accepted_stops,total_stops:2,vehicle_route_verified:false,display_verified:false,...(body.session_expires_at?{session_expires_at:body.session_expires_at}:{})};
      } else if(executionBudget&&!mode){
        const summary=body.route_summary,n=confirmed.args.points.length;
        if(body.navigation_mode!=='experimental_gps_append'||body.completed!==false||summary?.TotalSteps!==n||summary?.AcceptedSteps!==n||summary?.AllAPIAccepted!==true||summary?.Partial!==false||summary?.Blocked!==false||summary?.VehicleRouteVerified!==false)throw Error('command_outcome_unknown');
        coordinateRouteResult={navigation_mode:'experimental_gps_append',coordinate_route:{total_stops:n,accepted_stops:n,atomic:false,vehicle_route_verified:false}};
      }
      if(mode){
        const count=mode==='experimental_native_coordinate_batch'?parseNativeCoordinates(confirmed.args.waypoints).length:1;
        if(body.navigation_mode!==mode||body.completed!==false||body.vehicle_route_verified!==false||body.api_actuation_count!==1||body.requested_destinations!==count||mode==='experimental_native_supercharger'&&body.site_id!==confirmed.args.site_id)throw Error('command_outcome_unknown');
        coordinateRouteResult={navigation_mode:mode,api_actuation_count:1,requested_destinations:count,vehicle_route_verified:false,battery_preconditioning_verified:false,...(mode==='experimental_native_supercharger'?{site_id:confirmed.args.site_id}:{})};
      }
    } catch (err) {
      // An uncertain network result must never trigger an automatic retry.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message === 'fetch failed')
        throw Error('command_outcome_unknown');
      throw err;
    }
    return { operation: confirmed.operation, accepted: true, completed: false,...(coordinateRouteResult??{}),
      ...nativeAcknowledgementResult(mode) };
    } catch (error) {
      console.info('TESLA_COMMAND_FAILURE_STAGE', stage);
      throw error;
    }
  }
  const lifecycle = commandLifecycle({ store, config: c, now });
  async function commandPlan(subject, operation, args, statusOnly=false) {
    if (c.env.TESLA_COMMANDS_ENABLED !== 'true' || c.env.TESLA_COMMAND_EXECUTION_ENABLED !== 'true') throw Error('disabled');
    if (typeof subject !== 'string' || !subject) throw Error('invalid_arguments');
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(c.env.TESLA_VEHICLE_VIN || '')) throw Error('configuration');
    return prepareOperation(operation,args,await commandOperationOptions(subject,operation,args,statusOnly));
  }
  async function executeRequestedCommand(subject, operation, args, requestId, invocation) {
    if (requestId === undefined) throw Error('invalid_arguments');
    const plan = await commandPlan(subject, operation, args);
    if(nativeMode(operation,args)==='experimental_native_supercharger'&&invocation!==undefined&&invocation.token===undefined)await nativeSelections.require(subject,args.site_id);
    if (invocation !== undefined) {
      const canonical = JSON.stringify(Object.entries(plan.args).sort(([a],[b])=>a.localeCompare(b)));
      const binding = hash(c.issuer+'\n'+subject+'\n'+c.env.TESLA_VEHICLE_VIN+'\n'+operation+'\n'+canonical);
      const context = 'direct-command-invocation:'+binding;
      if (invocation.token === undefined) {
        const expires = now()+120000;
        const token=seal({nonce:random(),expires},c.key,context);
        return {status:'invocation_ready',sent_to_vehicle:false,dispatch_performed:false,status_reference:lifecycle.reference(subject,plan),
          invocation_token:token,expires_at:new Date(expires).toISOString(),
          continuation:{operation,arguments:{...plan.args,_tesla_invocation_token:token}},
          next_step:'Call this same tool once using the exact continuation object. The reserved _tesla_invocation_token is internal metadata, removed before vehicle argument validation; it is never sent to Tesla. Do not ask the user for codes or another confirmation. Do not create a replacement after uncertain dispatch.'};
      }
      let token;
      try { token=unseal(invocation.token,c.key,context); } catch { throw Error('invalid_command_invocation'); }
      if (!/^[A-Za-z0-9_-]{43}$/.test(token?.nonce) || !Number.isFinite(token.expires)) throw Error('invalid_command_invocation');
      if(token.expires<=now())throw Error('command_invocation_expired');
      requestId='invocation:'+token.nonce;
    }
    const execute = executionBudget => withNavigationFixtureFence(subject,plan,requestId,navigationFence=>lifecycle.execute(subject, plan, requestId, beforeDispatch =>
      confirmCommand(subject, null, null, { operation: plan.operation, args: plan.args, executionBudget, navigationGuardOwner:navigationFence?.owner,navigationGuardScope:navigationFence?.scope,
        vehicle_fingerprint: hash(c.env.TESLA_VEHICLE_VIN) }, beforeDispatch)));
    return boundedPlan(plan) ? withGPSExecutionBudget(execute) : execute();

  }
  function checkedDiagnosticPoint(point) {
    if(!point||typeof point!=='object'||Array.isArray(point)||Object.getPrototypeOf(point)!==Object.prototype||Object.keys(point).length!==2||!Object.hasOwn(point,'lat')||!Object.hasOwn(point,'lon')||typeof point.lat!=='number'||!Number.isFinite(point.lat)||point.lat < -90||point.lat > 90||typeof point.lon!=='number'||!Number.isFinite(point.lon)||point.lon < -180||point.lon > 180)throw Error('invalid_arguments');
    return {lat:point.lat,lon:point.lon};
  }
  function diagnosticAccountScope(subject) {
    const vin=c.env.TESLA_VEHICLE_VIN||'';
    return createHmac('sha256',c.key).update('gps-diagnostic-account-v1\n'+c.issuer+'\n'+subject+'\n'+vin).digest('hex');
  }
  async function executeGPSDiagnosticPhase(subject,{phase,sessionID,accountScope,point,expectedAppendPoint,displayChecked,requestId}) {
    if(!gpsRouteExecutionEnabled)throw Error('command_transport_unsupported');
    if(c.env.TESLA_COMMANDS_ENABLED!=='true'||c.env.TESLA_COMMAND_EXECUTION_ENABLED!=='true'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(c.env.TESLA_VEHICLE_VIN||''))throw Error('disabled');
    if(typeof subject!=='string'||!subject||requestId===undefined)throw Error('invalid_arguments');
    const gpsDiagnostic={phase,session_id:sessionID,account_scope:accountScope,
      ...(phase==='replace'?{expected_append_point:expectedAppendPoint}:{}),
      ...(phase==='append'?{display_checked:displayChecked}:{})};
    const plan=prepareOperation('navigation_gps_request',{points:[point]},operationOptions(false,phase));
    const requestKey=phase==='replace'?'gps-diagnostic-replace:'+sessionID:'gps-diagnostic-append:'+sessionID;
    const run=executionBudget=>withGPSFixtureNavigationFence({store,config:c,subject,plan,requestId:requestKey,enabled:true,
      gpsDiagnostic:{phase,session_id:sessionID,account_scope:accountScope},
      run:({owner,scope})=>lifecycle.execute(subject,plan,requestKey,beforeDispatch=>confirmCommand(subject,null,null,{
        operation:plan.operation,args:plan.args,executionBudget,navigationGuardOwner:owner,navigationGuardScope:scope,
        vehicle_fingerprint:hash(c.env.TESLA_VEHICLE_VIN),gpsDiagnostic
      },beforeDispatch))});
    const result=await withGPSExecutionBudget(run);
    if(result?.result_reused===true)return {...result,operation:'navigation_gps_request',accepted:true,completed:false,
      navigation_mode:'experimental_gps_diagnostic',phase,session_id:sessionID,api_accepted:true,
      accepted_stops:phase==='replace'?1:2,total_stops:2,vehicle_route_verified:false,display_verified:false};
    return result;
  }
  async function executeGPSNavigationDiagnosticReplace(subject,args,requestId) {
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==2||!Object.hasOwn(args,'replace_point')||!Object.hasOwn(args,'append_point'))throw Error('invalid_arguments');
    const replacePoint=checkedDiagnosticPoint(args.replace_point),appendPoint=checkedDiagnosticPoint(args.append_point);
    const requestBinding=typeof requestId==='string'&&requestId.length>=1&&requestId.length<=256?'s:'+requestId:typeof requestId==='number'&&Number.isFinite(requestId)?'n:'+JSON.stringify(requestId):'';
    if(!requestBinding)throw Error('invalid_arguments');
    const scope=diagnosticAccountScope(subject);
    const identity=JSON.stringify([replacePoint,appendPoint]);
    const sessionID=createHmac('sha256',c.key).update('gps-diagnostic-session-v1\n'+scope+'\n'+requestBinding+'\n'+identity).digest('hex').slice(0,32);
    return executeGPSDiagnosticPhase(subject,{phase:'replace',sessionID,accountScope:scope,point:replacePoint,expectedAppendPoint:appendPoint,requestId});
  }
  async function executeGPSNavigationDiagnosticAppend(subject,args,requestId) {
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==3||!Object.hasOwn(args,'session_id')||!Object.hasOwn(args,'append_point')||args.display_checked!==true||typeof args.session_id!=='string'||!/^[a-f0-9]{32}$/.test(args.session_id))throw Error('invalid_arguments');
    const point=checkedDiagnosticPoint(args.append_point),scope=diagnosticAccountScope(subject);
    return executeGPSDiagnosticPhase(subject,{phase:'append',sessionID:args.session_id,accountScope:scope,point,displayChecked:true,requestId});
  }
  async function vehicleCommandStatus(subject, operation, args, selector = {}) {
    let stage = 'status_selector_validation';
    try {
      if (c.env.TESLA_COMMANDS_ENABLED !== 'true' || c.env.TESLA_COMMAND_EXECUTION_ENABLED !== 'true') throw Error('disabled');
      if (typeof subject !== 'string' || !subject) throw Error('invalid_arguments');
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(c.env.TESLA_VEHICLE_VIN || '')) throw Error('configuration');
      const count = Number(args !== undefined) + Number(selector.requestId !== undefined) + Number(selector.statusReference !== undefined);
      if (count !== 1 || operation !== undefined && !Object.hasOwn(operationDefinitions(), operation)) throw Error('invalid_arguments');
      const plan = args !== undefined ? await commandPlan(subject, operation, args, true) : { operation };
      stage = 'status_state_lookup';
      const result=await lifecycle.status(subject, plan, selector);
      const navigationFence=plan.args!==undefined ? await gpsNavigationFenceStatus({store,config:c,subject,plan}) : null;
      return navigationFence?.blocked ? {...result,navigation_fence:navigationFence} : result;
    } catch (cause) {
      // Status has no Tesla transport: HTTP/storage failures here must not ask
      // the user to reauthorize Tesla or reveal provider exception text.
      const storageTransport = stage === 'status_state_lookup' &&
        (['upstream','reauthorize'].includes(cause.message) || ['AbortError','TimeoutError'].includes(cause.name) || cause.message === 'fetch failed');
      const error = storageTransport ? Error('store') : cause;
      error.commandStatusStage ??= error.commandJournalInvalid ? 'status_journal_decode' : stage;
      throw error;
    }
  }
  const preferences = chargingPreferences({ config: c, store, now });
  const privatePlaces = savedTripPlaces({config:c,store,now,verifyGooglePlaceIds:(subject,ids)=>destinationCache.verifyGooglePlaceIds(subject,ids)});
  const tripPlans = tripNavigation({ config: c, store, now });
  const acquirePublicGeocoderLease = () => store.acquirePublicGeocoderLease({ provider: 'nominatim', intervalMs: 1000 });
  async function withTripReadLease(operation) {
    // Shared across MCP invocations/instances for this configured vehicle.
    const lock = await store.lock('smart-trip-read:' + hash(c.env.TESLA_VEHICLE_VIN || 'unconfigured'));
    try { return await operation(); }
    finally { await lock.release().catch(() => {}); }
  }
  return { preferences, savedTripPlaces:privatePlaces, tripPlans, destinationCache, acquirePublicGeocoderLease, withTripReadLease, start, launch, partnerRegistration, partnerKeyCheck, prepareConnect, connectionStatus, prepareVehicleCommandSetup, callback, battery, vehicleConnectivity, vehicleReadingHistory, vehicleSchedules, location, nearbyChargingSites, chargingHistory, serviceHistory, serviceVisitDetails, prepareCommand, confirmCommand, executeRequestedCommand, executeGPSNavigationDiagnosticReplace, executeGPSNavigationDiagnosticAppend, vehicleCommandStatus };
}


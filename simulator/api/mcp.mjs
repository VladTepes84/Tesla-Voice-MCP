import { freeToXTariffTool, getFreeToXCardTariffs } from '../lib/public-tariffs.mjs';
import { safeToolFailure } from '../lib/tool-errors.mjs';
import { chargingRouteTool, planChargingRoadTrip } from '../lib/charging-route.mjs';
import { roadTripTools, invokeRoadTrip } from '../lib/road-trip.mjs';
import { requiredToolScope, mcpAuthorizationRequired } from '../lib/mcp-tool-auth.mjs';
import modern, { createWorker } from '../worker.mjs';
import { authenticate, matchesAudience, headers, https } from '../lib/security.mjs';
import { fetchPreviewJwks } from '../lib/preview-jwks.mjs';
import { runtime, realTeslaReadCodeReleased, hasRealTeslaFlags } from '../lib/runtime.mjs';
import { realMcp } from '../lib/real-mcp.mjs';
import { energyEstimateTool, estimateTripEnergy } from '../lib/energy-estimate.mjs';
import { chargingCostTool, compareChargingCosts } from '../lib/charge-cost-comparison.mjs';
import { planTrip, tripPlanTool } from '../lib/trip-plan.mjs';

// OAuth-protected simulation for Preview and disabled Production.
// No Tesla API, Tesla token store or vehicle access. Battery data is invented;
// map tools use public providers only after delegated scope and explicit consent.
const previewTool = Object.freeze({
  name: 'get_simulated_battery',
  description: 'Returns a simulated battery level for testing OAuth. Never contacts a real vehicle.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: ['battery:read'] }]
});

// Only categorical, non-identifying diagnostics. Never log OAuth tokens,
// token claims, JWT headers, account IDs, user details or request bodies.
// These diagnostics cannot grant access or change the security decision.
// Log only fixed provider classes, never values, subject IDs or token claims.
function subjectProviderClass(value) {
  if (typeof value !== 'string' || !value) return 'missing';
  if (value.endsWith('@clients')) return 'machine';
  if (value.startsWith('auth0|')) return 'auth0';
  if (value.startsWith('github|')) return 'github';
  if (value.startsWith('google-oauth2|')) return 'google';
  if (value.startsWith('apple|')) return 'apple';
  if (value.startsWith('email|')) return 'email';
  return 'other';
}
function subjectMismatchClass(actual, allowed) {
  if (typeof allowed !== 'string' || !allowed) return 'subject_config_missing';
  if (typeof actual !== 'string' || !actual) return 'subject_token_missing';
  if (actual === allowed.trim()) return 'subject_config_whitespace';
  if (actual === allowed.replace(/^[\x22']|[\x22']$/g, '')) return 'subject_config_quoted';
  return 'subject_mismatch_received_' + subjectProviderClass(actual) + '_configured_' + subjectProviderClass(allowed);
}

function rejectedTokenCategory(request, config) {
  try {
    const bearer = request.headers.get('authorization');
    if (!bearer?.startsWith('Bearer ') || bearer.length > 16384) return 'missing_or_malformed_bearer';
    const parts = bearer.slice(7).split('.');
    if (parts.length !== 3) return 'not_jwt';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.iss !== config.issuer) return 'issuer_mismatch';
    if (!matchesAudience(payload.aud, config.audience)) return Array.isArray(payload.aud) ? 'audience_array_missing_resource' : 'audience_mismatch';
    if (payload.sub !== config.env.MCP_ALLOWED_SUBJECT) return subjectMismatchClass(payload.sub, config.env.MCP_ALLOWED_SUBJECT);
    if (typeof payload.scope !== 'string' || !config.authenticationScopes.some(scope => payload.scope.split(' ').includes(scope))) return 'scope_mismatch';
    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return 'expired';
    return 'signature_or_other';
  } catch { return 'token_format'; }
}

function createProtectedSimulation(env) {
  const origin = https(env.APP_ORIGIN).origin;
  if (env.APP_ORIGIN !== origin) throw Error('configuration');
  const configuredIssuer = env.MCP_AUTH_ISSUER;
  const issuer = https(configuredIssuer).href;
  if (issuer !== configuredIssuer) throw Error('configuration');
  // Deployment UI can accidentally include surrounding whitespace/newlines.
  // Normalize only the configured allowlisted subject; compare the signed JWT
  // subject by exact equality and retain all other OAuth security checks.
  const allowedSubject = typeof env.MCP_ALLOWED_SUBJECT === 'string'
    ? env.MCP_ALLOWED_SUBJECT.trim() : '';
  if (!allowedSubject) throw Error('configuration');
  const config = {
    env: { ...env, MCP_ALLOWED_SUBJECT: allowedSubject },
    origin, issuer, audience: origin + '/mcp',
    authenticationScopes: env.VERCEL_ENV === 'preview' ? ['battery:read','location:read'] : ['battery:read']
  };
  const simulationWorker = (request, jwks) => createWorker({
    authorizeTool: name => authenticate(request, { ...config, jwks }, requiredToolScope(name)),
    onAuthorizationError: name => mcpAuthorizationRequired(origin, name),
    onToolError: error => safeToolFailure(error),
    exposedTools: env.VERCEL_ENV === 'preview' ? [previewTool, energyEstimateTool, chargingCostTool, tripPlanTool, freeToXTariffTool, ...roadTripTools, chargingRouteTool] : [previewTool],
    serverName: env.VERCEL_ENV === 'production' ? 'tesla-voice-oauth-simulated' : 'tesla-voice-oauth-preview',
    invokeTool: async (name, args) => name === freeToXTariffTool.name ? getFreeToXCardTariffs() : name === chargingRouteTool.name ? planChargingRoadTrip(args) : roadTripTools.some(t => t.name === name) ? invokeRoadTrip(name, args) : name === 'plan_trip' ? planTrip(args) : name === 'estimate_trip_energy' ? estimateTripEnergy(args) :
      name === 'compare_charging_costs' ? compareChargingCosts(args) : ({
      source: 'SIMULATED',
      battery_percent: 70,
      note: 'TEST ONLY: fixed invented data, no Tesla account or vehicle contacted.'
    })
  });
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== origin || url.pathname !== '/mcp') return new Response(null, { status: 404, headers });
    if (request.headers.has('origin') && request.headers.get('origin') !== origin) return new Response(null, { status: 403, headers });
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
    }
    const unauthorized = () => new Response('Unauthorized', {
      status: 401,
      headers: {
        ...headers,
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${config.authenticationScopes.join(' ')}"`
      }
    });
    if (!request.headers.get('authorization')?.startsWith('Bearer ')) return unauthorized();
    let jwks;
    try {
      // Production uses only the existing pinned, public Auth0 RSA verification keys.
      // Preview uses its existing public JWKS fetch. Neither path accesses Tesla.
      jwks = env.VERCEL_ENV === 'production' ? JSON.parse(env.MCP_AUTH_JWKS) : await fetchPreviewJwks(issuer);
      if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw Error('configuration');
    } catch { return new Response(null, { status: 503, headers }); }
    try {
      if (!config.authenticationScopes.some(scope => {
        try { authenticate(request, { ...config, jwks }, scope); return true; } catch { return false; }
      })) throw Error('unauthorized');
    }
    catch {
      console.info('MCP_OAUTH_REJECT', rejectedTokenCategory(request, config));
      return unauthorized();
    }
    const response = await simulationWorker(request, jwks).fetch(request);
    const era = request.headers.has('mcp-protocol-version') ? 'versioned' : 'handshake_or_no_header';
    console.info('MCP_DISPATCH', era, response.status);
    return response;
  };
}

// Disabled by default. This mode exposes synthetic public data only.
// It is not OAuth authentication and must not be used with real Tesla data.
export function createHandler(mode = process.env.SIMULATED_MCP_MODE) {
  return async function fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (url.protocol !== 'https:') return new Response(null, { status: 400 });
    if (mode !== 'public-simulated') return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    return modern.fetch(request);
  };
}

export default {
  fetch: async request => {
    // Presence-only routing diagnostics. No tokens, identities, URLs or payloads.
    // A GET probe must reach this line before Vercel can show the expected 405.
    const diagnosticPath = new URL(request.url).pathname;
    console.info('MCP_ENTRY',
      diagnosticPath === '/mcp' ? 'path_mcp' : 'path_other',
      request.method === 'POST' ? 'method_post' : request.method === 'GET' ? 'method_get' : 'method_other',
      request.headers.has('authorization') ? 'auth_present' : 'auth_absent');
    // Fail closed on any Preview attempt to enable real Tesla access.
    if (process.env.VERCEL_ENV === 'preview') {
      if (hasRealTeslaFlags()) {
        return new Response(null, { status: 503, headers });
      }
      try { return await createProtectedSimulation(process.env)(request); }
      catch { console.warn('MCP_SETUP_REJECT', 'protected_simulation'); return new Response(null, { status: 503, headers }); }
    }
    // Once any Tesla release flag is set, never silently return simulation.
    // The owner may enable account linking before enabling battery reads.
    const teslaBackendRequested = hasRealTeslaFlags();
    if (teslaBackendRequested) {
      // runtime() independently checks production, explicit approval, backend
      // configuration and the existing auth/storage guards. Any failure is 503.
      if (!realTeslaReadCodeReleased || process.env.VERCEL_ENV !== 'production') {
        return new Response(null, { status: 503, headers });
      }
      try { return await realMcp(runtime())(request); }
      catch { return new Response(null, { status: 503, headers }); }
    }
    // Tesla OAuth account-link endpoints remain independent (/oauth/tesla/*).
    // Public simulation is available only when every real-backend gate is off.
    if (process.env.SIMULATED_MCP_MODE === 'public-simulated' &&
        !request.headers.has('authorization')) return createHandler()(request);
    console.info('MCP_ROUTE', 'protected_simulated_only');
    try { return await createProtectedSimulation(process.env)(request); }
    catch { console.warn('MCP_SETUP_REJECT', 'protected_simulation'); return new Response(null, { status: 503, headers }); }
  }
};

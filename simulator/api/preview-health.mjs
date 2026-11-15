import { headers, https } from '../lib/security.mjs';
import { fetchPreviewJwks } from '../lib/preview-jwks.mjs';
import { hasRealTeslaFlags } from '../lib/runtime.mjs';

// Temporary Preview-only OAuth diagnostic. Report failed check names, never values,
// secrets, JWTs, hashes, user identifiers or external API responses.
// No Tesla network calls or real vehicle operations.
function valid(check) {
  try { return Boolean(check()); } catch { return false; }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (process.env.VERCEL_ENV !== 'preview' || url.pathname !== '/diagnostics/oauth-preview') {
      return new Response(null, { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
    }
    const env = process.env;
    const checks = {
      app_origin: valid(() => {
        const canonical = https(env.APP_ORIGIN).origin;
        return env.APP_ORIGIN === canonical && canonical === url.origin;
      }),
      auth_issuer: valid(() => {
        const issuer = https(env.MCP_AUTH_ISSUER).href;
        return issuer === env.MCP_AUTH_ISSUER;
      }),
      // Auth0 exposes PUBLIC JWKS: Preview refreshes them from the pinned issuer.
      // Real Tesla and Production continue to use their existing, unchanged security settings.
      jwks: false,
      allowed_subject: valid(() => typeof env.MCP_ALLOWED_SUBJECT === 'string' && env.MCP_ALLOWED_SUBJECT.trim().length > 0),
      preview_tesla_flags_disabled: !hasRealTeslaFlags(env)
    };
    if (checks.auth_issuer) {
      try {
        const jwks = await fetchPreviewJwks(env.MCP_AUTH_ISSUER);
        checks.jwks = jwks.keys.length > 0;
      } catch { checks.jwks = false; }
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    return Response.json({
      service: 'tesla-voice-oauth-preview',
      canonical_preview_origin_matches: checks.app_origin,
      oauth_configuration: failed.length ? 'incomplete' : 'ready',
      failed_checks: failed,
      tesla_real_access: checks.preview_tesla_flags_disabled ? 'disabled_on_mcp_preview' : 'preview_configuration_blocked'
    }, { headers });
  }
};

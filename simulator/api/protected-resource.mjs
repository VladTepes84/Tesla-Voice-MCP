import { https, headers } from '../lib/security.mjs';
import { hasRealTeslaFlags } from '../lib/runtime.mjs';
export default {
  fetch(request) {
    try {
      const origin = https(process.env.APP_ORIGIN).origin;
      const issuer = process.env.MCP_AUTH_ISSUER;
      https(issuer);
      const url = new URL(request.url);
      if (url.origin !== origin || url.pathname !== '/.well-known/oauth-protected-resource') return new Response(null, { status: 404, headers });
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
      // Preview exposes simulated battery and public map tools.
      // Real Tesla reads stay disabled.
      // Map-only Preview tools require location scope, but never expose commands.
      const preview = process.env.VERCEL_ENV === 'preview';
      // A production deployment with all real Tesla gates disabled exposes
      // only the OAuth-protected synthetic battery tool. Advertise its scope
      // rather than tesla:connect, so first-time OAuth onboarding can succeed.
      const realBackendRequested = hasRealTeslaFlags(process.env);
      const scopes = preview ? ['battery:read', 'location:read'] : realBackendRequested ? ['tesla:connect'] : ['battery:read'];
      if (!preview && process.env.TESLA_READ_ENABLED === 'true') scopes.push('battery:read');
      if (!preview && process.env.TESLA_READ_ENABLED === 'true' && process.env.TESLA_LOCATION_ENABLED === 'true') scopes.push('location:read');
      if (!preview && process.env.TESLA_READ_ENABLED === 'true' && process.env.TESLA_COMMANDS_ENABLED === 'true' && process.env.TESLA_COMMAND_EXECUTION_ENABLED === 'true') scopes.push('vehicle:control');
      return Response.json({ resource: origin + '/mcp', authorization_servers: [issuer], scopes_supported: scopes }, { headers });
    } catch { return new Response(null, { status: 503, headers }); }
  }
};

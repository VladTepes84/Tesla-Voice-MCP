import { configuration, headers } from './security.mjs';
import { persistentStore } from './store.mjs';
import { createTeslaBackend } from './tesla.mjs';
export const realTeslaFlags = Object.freeze([
  'TESLA_BACKEND_ENABLED', 'TESLA_READ_ENABLED', 'TESLA_REAL_RELEASE_APPROVED',
  'TESLA_LOCATION_ENABLED', 'TESLA_COMMANDS_ENABLED', 'TESLA_COMMAND_EXECUTION_ENABLED'
]);
export const hasRealTeslaFlags = (env = process.env) => realTeslaFlags.some(name => env[name] === 'true');
// Release the read-only MCP path only with the separate production env gates.
export const realTeslaReadCodeReleased = true;
export function runtime(env = process.env) {
  // Production only, with explicit owner approval and a tested shared daily budget.
  const realTeslaCodeReleased = true;
  if (!realTeslaCodeReleased || env.VERCEL_ENV !== 'production' ||
      env.TESLA_REAL_RELEASE_APPROVED !== 'true') throw Error('disabled');
  if ((env.TESLA_LOCATION_ENABLED === 'true' || env.TESLA_COMMANDS_ENABLED === 'true' ||
       env.TESLA_COMMAND_EXECUTION_ENABLED === 'true') && env.TESLA_READ_ENABLED !== 'true') {
    throw Error('inconsistent_release_flags');
  }
  if (env.TESLA_COMMAND_EXECUTION_ENABLED === 'true' && env.TESLA_COMMANDS_ENABLED !== 'true') {
    throw Error('inconsistent_release_flags');
  }
  // Defense in depth: a mistakenly enabled env flag cannot allow vehicle reads.
  const safeEnv = { ...env, TESLA_READ_ENABLED:
    realTeslaReadCodeReleased && env.TESLA_READ_ENABLED === 'true' ? 'true' : 'false',
    TESLA_COMMANDS_ENABLED: realTeslaCodeReleased && env.TESLA_COMMANDS_ENABLED === 'true' ? 'true' : 'false',
    TESLA_COMMAND_EXECUTION_ENABLED: realTeslaCodeReleased && env.TESLA_COMMAND_EXECUTION_ENABLED === 'true' ? 'true' : 'false' };
  const config = configuration(safeEnv);
  return { config, backend: createTeslaBackend({ config, store: persistentStore(env) }) };
}
export function route(operation) {
  return async request => {
    try {
      const { config, backend } = runtime();
      const url = new URL(request.url);
      const paths = { start: '/oauth/tesla/start', launch: '/oauth/tesla/launch', callback: '/oauth/tesla/callback', partnerRegistration: '/oauth/tesla/partner-registration', partnerKeyCheck: '/oauth/tesla/partner-key-check' };
      const path = paths[operation];
      if (!path) throw Error('disabled');
      const partnerCheckTicketPath = operation === 'partnerKeyCheck' &&
        /^\/oauth\/tesla\/partner-key-check\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
      if (url.origin !== config.origin || (url.pathname !== path && !partnerCheckTicketPath))
        return new Response(null, { status: 404, headers });
      return await backend[operation](request);
    } catch { return new Response('Servizio non disponibile.', { status: 503, headers }); }
  };
}

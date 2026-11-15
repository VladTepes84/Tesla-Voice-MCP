import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './lib/runtime.mjs';
import startRoute from './api/oauth/tesla/start.mjs';
import callbackRoute from './api/oauth/tesla/callback.mjs';
import mcpRoute from './api/mcp.mjs';

// No Tesla credentials, Redis instance or outbound network are needed.
// Even an incorrectly enabled Preview cannot instantiate the real backend.
test('Preview and unapproved Production refuse real Tesla backend independently of credentials', () => {
  assert.throws(
    () => runtime({ VERCEL_ENV: 'preview', TESLA_BACKEND_ENABLED: 'true', TESLA_READ_ENABLED: 'true',
      TESLA_REAL_RELEASE_APPROVED: 'true' }),
    /disabled/
  );
  assert.throws(
    () => runtime({ VERCEL_ENV: 'production', TESLA_BACKEND_ENABLED: 'true', TESLA_READ_ENABLED: 'true' }),
    /disabled/
  );
  assert.throws(
    () => runtime({ VERCEL_ENV: 'production', TESLA_BACKEND_ENABLED: 'true',
      TESLA_REAL_RELEASE_APPROVED: 'true', TESLA_READ_ENABLED: 'false', TESLA_LOCATION_ENABLED: 'true' }),
    /inconsistent_release_flags/
  );
  assert.throws(
    () => runtime({ VERCEL_ENV: 'production', TESLA_BACKEND_ENABLED: 'true',
      TESLA_REAL_RELEASE_APPROVED: 'true', TESLA_READ_ENABLED: 'true', TESLA_COMMAND_EXECUTION_ENABLED: 'true' }),
    /inconsistent_release_flags/
  );
  assert.throws(
    () => runtime({ VERCEL_ENV: 'development', TESLA_BACKEND_ENABLED: 'true',
      TESLA_REAL_RELEASE_APPROVED: 'true' }),
    /disabled/
  );
  // An incomplete Production configuration never enables the real MCP backend.
  assert.throws(
    () => runtime({ VERCEL_ENV: 'production', TESLA_BACKEND_ENABLED: 'true', TESLA_READ_ENABLED: 'true',
      TESLA_REAL_RELEASE_APPROVED: 'true' }),
    /Invalid URL|configuration/
  );
});

test('Preview rejects ALL real Tesla routes despite accidental real flags', async () => {
  const names = ['VERCEL_ENV', 'TESLA_BACKEND_ENABLED', 'TESLA_READ_ENABLED', 'TESLA_REAL_RELEASE_APPROVED',
    'TESLA_LOCATION_ENABLED', 'TESLA_COMMANDS_ENABLED', 'TESLA_COMMAND_EXECUTION_ENABLED', 'APP_ORIGIN'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  let outgoing = 0;
  try {
    Object.assign(process.env, {
      VERCEL_ENV: 'preview',
      TESLA_BACKEND_ENABLED: 'true',
      TESLA_READ_ENABLED: 'true',
      TESLA_REAL_RELEASE_APPROVED: 'true', TESLA_LOCATION_ENABLED: 'true',
      TESLA_COMMANDS_ENABLED: 'true', TESLA_COMMAND_EXECUTION_ENABLED: 'true',
      APP_ORIGIN: 'https://example.invalid'
    });
    globalThis.fetch = async () => { outgoing++; throw Error('Outbound network must not occur in Preview'); };
    const cases = [
      [startRoute.fetch, new Request('https://example.invalid/oauth/tesla/start', { method: 'POST',
        headers: { origin: 'https://example.invalid', 'content-type': 'application/json', authorization: 'Bearer fixture' },
        body: '{}' })],
      [callbackRoute.fetch, new Request('https://example.invalid/oauth/tesla/callback?state=fake&code=fake',
        { method: 'GET', headers: { cookie: '__Host-tesla-oauth=fake' } })],
      [mcpRoute.fetch, new Request('https://example.invalid/mcp', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}' })]
    ];
    for (const [handler, request] of cases) {
      const result = await handler(request);
      assert.equal(result.status, 503);
      assert.doesNotMatch(await result.text(), /Bearer fixture|fake|token|Tesla collegata/);
    }
    assert.equal(outgoing, 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import mcpHandler from './api/mcp.mjs';
import resourceHandler from './api/protected-resource.mjs';

// Clean-room onboarding check: a fresh local HTTP adapter to the actual MCP
// handlers, with invented OAuth keys/claims only. No Tesla, Google, Vercel,
// real provider credential or external network requests are necessary.
test('isolated first-install smoke: metadata, JWT, discovery, tools and no vehicle access', async () => {
  const names = [
    'VERCEL_ENV','APP_ORIGIN','MCP_AUTH_ISSUER','MCP_AUTH_JWKS',
    'MCP_ALLOWED_SUBJECT','SIMULATED_MCP_MODE','TESLA_BACKEND_ENABLED',
    'TESLA_READ_ENABLED','TESLA_REAL_RELEASE_APPROVED',
    'TESLA_LOCATION_ENABLED','TESLA_COMMANDS_ENABLED',
    'TESLA_COMMAND_EXECUTION_ENABLED','GOOGLE_PLACES_SEARCH_ENABLED',
    'GOOGLE_PLACES_API_KEY','TESLA_CLIENT_ID','TESLA_CLIENT_SECRET',
    'TESLA_VEHICLE_VIN','TOKEN_STORE_REST_URL','TOKEN_STORE_REST_TOKEN'
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const origin = 'https://mcp-demo.example.invalid';
  const issuer = 'https://oauth-demo.example.invalid/';
  const subject = 'synthetic-onboarding-operator';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = publicKey.export({ format: 'jwk' });
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, {
      VERCEL_ENV: 'production',
      APP_ORIGIN: origin,
      MCP_AUTH_ISSUER: issuer,
      MCP_AUTH_JWKS: JSON.stringify({ keys: [{ ...pub, kid: 'ephemeral-synthetic', use: 'sig', alg: 'RS256' }] }),
      MCP_ALLOWED_SUBJECT: subject
    });
    const jwt = (overrides = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ephemeral-synthetic' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({
        iss: issuer, aud: origin + '/mcp', sub: subject,
        iat: now, exp: now + 300, scope: 'battery:read', ...overrides
      })).toString('base64url');
      const encoded = head + '.' + body;
      return encoded + '.' + sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url');
    };
    // HTTP loopback adapter emulates the host request/response boundary;
    // the underlying handlers receive a synthetic HTTPS origin.
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const request = new Request(origin + req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body })
        });
        const handler = req.url === '/.well-known/oauth-protected-resource' ? resourceHandler : mcpHandler;
        const response = await handler.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end('synthetic-adapter-failure');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      const requestMcp = async (method, params = {}, bearer) => {
        const meta = {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'clean-room-fixture', version: '1' }
        };
        const headers = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
          ...(bearer ? { authorization: 'Bearer ' + bearer } : {})
        };
        const response = await fetch(base + '/mcp', {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } })
        });
        return { status: response.status, data: await response.json().catch(() => null) };
      };
      const metaResp = await fetch(base + '/.well-known/oauth-protected-resource');
      assert.equal(metaResp.status, 200);
      const metadata = await metaResp.json();
      assert.equal(metadata.resource, origin + '/mcp');
      assert.deepEqual(metadata.authorization_servers, [issuer]);
      assert.ok(metadata.scopes_supported.includes('battery:read'), 'Protected simulated battery tool must appear in resource metadata');

      assert.equal((await requestMcp('tools/list')).status, 401, 'MCP must reject anonymous requests');
      assert.equal((await requestMcp('tools/list', {}, jwt({ aud: 'https://other.example.invalid/mcp' }))).status, 401);
      assert.equal((await requestMcp('tools/list', {}, jwt({ sub: 'not-this-operator' }))).status, 401);
      assert.equal((await requestMcp('tools/list', {}, jwt({ scope: 'vehicle:control' }))).status, 401);
      assert.equal((await requestMcp('tools/list', {}, jwt({ exp: 1 }))).status, 401);
      const good = jwt();
      const listed = await requestMcp('tools/list', {}, good);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.data.result.tools.map(tool => tool.name), ['get_simulated_battery']);
      const result = await requestMcp('tools/call', { name: 'get_simulated_battery', arguments: {} }, good);
      assert.equal(result.status, 200);
      assert.equal(result.data.result.isError, false);
      const battery = JSON.parse(result.data.result.content[0].text);
      assert.equal(battery.source, 'SIMULATED');
      assert.equal(battery.battery_percent, 70);
      assert.match(battery.note, /TEST ONLY/);
      const denied = await requestMcp('tools/call', { name: 'execute_requested_vehicle_command', arguments: {} }, good);
      assert.notEqual(denied.data?.result?.isError, false);
      assert.equal(denied.data.error.code, -32602);
      // The first-time installer reaches the synthetic MCP result without
      // any provider credentials or Tesla traffic.
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

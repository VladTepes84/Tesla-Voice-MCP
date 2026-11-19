import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import endpoint from './api/mcp.mjs';
import { request } from './offline-request.mjs';

// Fully offline integration test. No Auth0 credentials, Tesla account, Redis or vehicle access.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'production-simulation-test', alg: 'RS256', use: 'sig' };
const origin = 'https://example.invalid';
const issuer = 'https://issuer.example.invalid/';
const changes = {
  VERCEL_ENV: 'production',
  APP_ORIGIN: origin,
  MCP_AUTH_ISSUER: issuer,
  MCP_AUTH_JWKS: JSON.stringify({ keys: [key] }),
  MCP_ALLOWED_SUBJECT: 'test-owner',
  TESLA_BACKEND_ENABLED: 'false',
  TESLA_READ_ENABLED: 'false',
  TESLA_REAL_RELEASE_APPROVED: 'false',
  TESLA_LOCATION_ENABLED: 'false',
  TESLA_COMMANDS_ENABLED: 'false',
  TESLA_COMMAND_EXECUTION_ENABLED: 'false',
  SIMULATED_MCP_MODE: ''
};
const oldEnv = Object.fromEntries(Object.keys(changes).map(k => [k, process.env[k]]));
Object.assign(process.env, changes);
const oldFetch = globalThis.fetch;
let outbound = 0;
globalThis.fetch = async () => { outbound++; throw Error('Unexpected outbound network call'); };
after(() => {
  globalThis.fetch = oldFetch;
  for (const [k,v] of Object.entries(oldEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
function token(overrides = {}, header = {}) {
  const now = Math.floor(Date.now()/1000);
  const h = Buffer.from(JSON.stringify({alg: 'RS256',typ: 'JWT',kid: key.kid,...header})).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: issuer, aud: origin+'/mcp', sub: 'test-owner',
    scope: 'battery:read', iat: now, exp: now+600, ...overrides
  })).toString('base64url');
  return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');
}
function rpc(method, params = {}, bearer) {
  const base = request(method,params);
  const headers = new Headers(base.headers);
  if(bearer) headers.set('authorization','Bearer '+bearer);
  return new Request(base.url,{method:base.method,headers,body:base.body,duplex:'half'});
}
test('production GET reaches the MCP handler as HTTP 405, not a proxy 401', async () => {
  const response = await endpoint.fetch(new Request(origin + '/mcp', { method: 'GET' }));
  assert.equal(response.status, 405);
  assert.equal(outbound, 0);
});
test('GET with diagnostic query still cannot bypass MCP POST-only gate', async () => {
  const response = await endpoint.fetch(new Request(origin + '/mcp?transport_probe=route', { method: 'GET' }));
  assert.equal(response.status, 405);
  assert.equal(outbound, 0);
});
test('production disabled backend challenges OAuth rather than returning 503 for MCP discovery',async()=>{
  const r=await endpoint.fetch(rpc('server/discover'));
  assert.equal(r.status,401);
  assert.match(r.headers.get('www-authenticate'),/oauth-protected-resource/);
  assert.equal(outbound,0);
});
test('OAuth API JWT discovers, lists and invokes strictly simulated battery, with no Tesla calls',async()=>{
  const bearer=token();
  const discovery=await endpoint.fetch(rpc('server/discover',{},bearer));
  assert.equal(discovery.status,200);
  assert.equal((await discovery.json()).result._meta['io.modelcontextprotocol/serverInfo'].name,'tesla-voice-oauth-simulated');
  const listed=await endpoint.fetch(rpc('tools/list',{},bearer));
  assert.equal(listed.status,200);
  assert.deepEqual((await listed.json()).result.tools.map(x=>x.name),['get_simulated_battery']);
  // Real Auth0 tokens can target both the API and Auth0 userinfo.
  const auth0ArrayToken = token({ aud: [origin + '/mcp', 'https://issuer.example.invalid/userinfo'] });
  const arrayDiscovery = await endpoint.fetch(rpc('server/discover', {}, auth0ArrayToken));
  assert.equal(arrayDiscovery.status, 200);
  const arrayTools = await endpoint.fetch(rpc('tools/list', {}, auth0ArrayToken));
  assert.equal(arrayTools.status, 200);
  assert.deepEqual((await arrayTools.json()).result.tools.map(x => x.name), ['get_simulated_battery']);
  const call=await endpoint.fetch(rpc('tools/call',{name:'get_simulated_battery',arguments:{}},bearer));
  assert.equal(call.status,200);
  const result=JSON.parse((await call.json()).result.content[0].text);
  assert.equal(result.source,'SIMULATED');
  assert.equal(result.battery_percent,70);
  assert.equal(outbound,0);
});
test('production trims accidental allowlisted-subject whitespace without broadening identity access', async () => {
  const original = process.env.MCP_ALLOWED_SUBJECT;
  process.env.MCP_ALLOWED_SUBJECT = '  \n  test-owner  \t  ';
  try {
    const bearer = token();
    const discovery = await endpoint.fetch(rpc('server/discover', {}, bearer));
    assert.equal(discovery.status, 200);
    const listed = await endpoint.fetch(rpc('tools/list', {}, bearer));
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).result.tools.map(t => t.name), ['get_simulated_battery']);
    const otherUser = await endpoint.fetch(rpc('tools/list', {}, token({ sub: 'other-user' })));
    assert.equal(otherUser.status, 401);
    assert.equal(outbound, 0);
  } finally {
    if (original === undefined) delete process.env.MCP_ALLOWED_SUBJECT;
    else process.env.MCP_ALLOWED_SUBJECT = original;
  }
});

test('Production simulated OAuth rejects invalid token and never becomes anonymously accessible',async()=>{
  for(const bearer of [undefined,token({sub:'another-owner'}),token({aud:'https://other.invalid/mcp'}),token({aud:['https://other.invalid/mcp','https://issuer.example.invalid/userinfo']}),token({aud:[origin + '/mcp',1]}),token({scope:'tesla:connect'}),token({iss:'https://wrong.invalid/'}),token({}, {alg:'none'})]){
    const r=await endpoint.fetch(rpc('tools/list',{},bearer));
    assert.equal(r.status,401);
  }
  assert.equal(outbound,0);
});
test('production read route requires OAuth and exposes only the real read-only tools when configured', async () => {
  const names=['TESLA_BACKEND_ENABLED','TESLA_REAL_RELEASE_APPROVED','TESLA_READ_ENABLED',
    'TESLA_CLIENT_ID','TESLA_CLIENT_SECRET','TESLA_FLEET_REGION','TESLA_VEHICLE_VIN',
    'TESLA_DAILY_READ_LIMIT','TOKEN_ENCRYPTON_KEY_BASE64','TOKEN_STORE_REST_URL',
    'TOKEN_STORE_REST_TOKEN'];
  const previous = Object.fromEntries(names.map(k=>[k,process.env[k]]));
  Object.assign(process.env, {
    TESLA_BACKEND_ENABLED:'true', TESLA_REAL_RELEASE_APPROVED:'true', TESLA_READ_ENABLED:'true',
    TESLA_CLIENT_ID:'fixture-client', TESLA_CLIENT_SECRET:'fixture-secret',
    TESLA_FLEET_REGION:'eu', TESLA_VEHICLE_VIN:'5YJ3E1EA0LF000000',TESLA_DAILY_READ_LIMIT:'10',
    TOKEN_ENCRYPTON_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),
    TOKEN_STORE_REST_URL:'https://redis.invalid',TOKEN_STORE_REST_TOKEN:'fixture-store-token'
  });
  try {
    const missing = await endpoint.fetch(rpc('tools/list'));
    assert.equal(missing.status,401);
    const signed = token();
    const discovered = await endpoint.fetch(rpc('server/discover',{},signed));
    assert.equal(discovered.status,200);
    const list = await endpoint.fetch(rpc('tools/list',{},signed));
    assert.equal(list.status,200);
    assert.deepEqual((await list.json()).result.tools.map(x=>x.name),['connect_tesla','prepare_vehicle_command_setup','get_connection_status','get_vehicle_command_catalog','get_vehicle_connectivity','get_vehicle_mobile_access','get_battery','get_vehicle_status','get_live_vehicle_data','get_vehicle_reading_history','get_charging_history','get_service_history','get_service_visit_details','get_vehicle_schedules','estimate_trip_energy','compare_charging_costs','plan_trip','get_free_to_x_card_tariffs','get_charging_preferences','set_charging_preferences']);
    const catalogResponse = await endpoint.fetch(rpc('tools/call', {name:'get_vehicle_command_catalog',arguments:{}},token({scope:'battery:read'})));
    assert.equal(catalogResponse.status,200);
    const catalogRpc = await catalogResponse.json();
    const catalog = JSON.parse(catalogRpc.result.content[0].text);
    assert.equal(catalog.operation_count,75);
    assert.equal(catalog.operations.filter(item=>item.transport_supported).length,67);
    assert.equal(catalog.operations.filter(item=>!item.transport_supported).length,8);
    assert.equal(catalog.execution_enabled,false);
    assert.ok(catalog.operations.every(item=>item.vehicle_support==='not_verified'));
    const denied = await endpoint.fetch(rpc('tools/call', {name:'get_vehicle_command_catalog',arguments:{}},token({scope:'tesla:connect'})));
    assert.equal(denied.status,200);
    const challenge=await denied.json();
    assert.equal(challenge.result.isError,true);
    assert.match(challenge.result._meta['mcp/www_authenticate'][0],/scope="battery:read"/);
    assert.equal(outbound,0);
    delete process.env.TESLA_CLIENT_SECRET;
    const missingConfiguration = await endpoint.fetch(rpc('server/discover',{},signed));
    assert.equal(missingConfiguration.status,503);
    assert.equal(outbound,0);
  } finally {
    for (const [k,v] of Object.entries(previous)) {
      if(v === undefined) delete process.env[k]; else process.env[k]=v;
    }
  }
});

test('Production with Tesla backend enabled but reads disabled exposes only account linking', async () => {
  const names=['TESLA_BACKEND_ENABLED','TESLA_REAL_RELEASE_APPROVED','TESLA_READ_ENABLED',
    'TESLA_CLIENT_ID','TESLA_CLIENT_SECRET','TESLA_FLEET_REGION','TESLA_VEHICLE_VIN',
    'TESLA_DAILY_READ_LIMIT','TOKEN_ENCRYPTON_KEY_BASE64','TOKEN_STORE_REST_URL',
    'TOKEN_STORE_REST_TOKEN'];
  const previous = Object.fromEntries(names.map(k=>[k,process.env[k]]));
  Object.assign(process.env, {
    TESLA_BACKEND_ENABLED:'true', TESLA_REAL_RELEASE_APPROVED:'true', TESLA_READ_ENABLED:'false',
    TESLA_CLIENT_ID:'fixture-client', TESLA_CLIENT_SECRET:'fixture-secret',
    TESLA_FLEET_REGION:'eu', TESLA_VEHICLE_VIN:'5YJ3E1EA0LF000000', TESLA_DAILY_READ_LIMIT:'10',
    TOKEN_ENCRYPTON_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),
    TOKEN_STORE_REST_URL:'https://redis.invalid', TOKEN_STORE_REST_TOKEN:'fixture-store-token'
  });
  try {
    const connectToken = token({ scope:'tesla:connect' });
    const response = await endpoint.fetch(rpc('tools/list',{},connectToken));
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).result.tools.map(x=>x.name),['connect_tesla','prepare_vehicle_command_setup']);
    assert.equal(outbound,0);
  } finally {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('A partial Production Tesla release fails closed instead of exposing simulated tools', async () => {
  const teslaFlags = ['TESLA_BACKEND_ENABLED','TESLA_READ_ENABLED','TESLA_REAL_RELEASE_APPROVED',
    'TESLA_LOCATION_ENABLED','TESLA_COMMANDS_ENABLED','TESLA_COMMAND_EXECUTION_ENABLED'];
  const previous = Object.fromEntries(teslaFlags.map(name=>[name,process.env[name]]));
  try {
    for (const flag of teslaFlags) {
      for (const name of teslaFlags) process.env[name] = 'false';
      process.env[flag] = 'true';
      const response = await endpoint.fetch(rpc('tools/list',{},token()));
      assert.equal(response.status,503,`${flag} must never fall back to simulated tools`);
    }
    assert.equal(outbound,0);
  } finally {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Production exposes real read-only MCP tools only with valid backend configuration', async () => {
  const original = { ...process.env };
  Object.assign(process.env, {
    VERCEL_ENV:'production', APP_ORIGIN:origin, MCP_AUTH_ISSUER:issuer,
    MCP_AUTH_JWKS:JSON.stringify({keys:[key]}), MCP_ALLOWED_SUBJECT:'test-owner',
    TOKEN_ENCRYPTON_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),
    TOKEN_STORE_REST_URL:'https://redis.invalid', TOKEN_STORE_REST_TOKEN:'fixture-store-token',
    TESLA_CLIENT_ID:'fixture-client', TESLA_CLIENT_SECRET:'fixture-secret',
    TESLA_FLEET_REGION:'eu', TESLA_VEHICLE_VIN:'5YJ3E1EA0LF000000',
    TESLA_DAILY_READ_LIMIT:'10', TESLA_BACKEND_ENABLED:'true',
    TESLA_READ_ENABLED:'true', TESLA_REAL_RELEASE_APPROVED:'true',
    TESLA_LOCATION_ENABLED:'false', TESLA_COMMANDS_ENABLED:'false', TESLA_COMMAND_EXECUTION_ENABLED:'false'
  });
  try {
    const response = await endpoint.fetch(rpc('tools/list',{},token()));
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).result.tools.map(x=>x.name),['connect_tesla','prepare_vehicle_command_setup','get_connection_status','get_vehicle_command_catalog','get_vehicle_connectivity','get_vehicle_mobile_access','get_battery','get_vehicle_status','get_live_vehicle_data','get_vehicle_reading_history','get_charging_history','get_service_history','get_service_visit_details','get_vehicle_schedules','estimate_trip_energy','compare_charging_costs','plan_trip','get_free_to_x_card_tariffs','get_charging_preferences','set_charging_preferences']);
    assert.equal(outbound,0);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env,original);
  }
});


function legacyRpc(method, params, bearer, id = 11) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  const body = { jsonrpc: '2.0', method, ...(id === null ? {} : { id }), ...(params ? { params } : {}) };
  return new Request(origin + '/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}
test('legacy handshake-era client completes OAuth-protected initialize, tools/list, battery call', async () => {
  const bearer = token();
  const initialized = await endpoint.fetch(legacyRpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1.0' }
  }, bearer));
  assert.equal(initialized.status, 200);
  const intro = (await initialized.json()).result;
  assert.equal(intro.protocolVersion, '2025-11-25');
  assert.deepEqual(intro.capabilities, { tools: {} });
  assert.equal((await endpoint.fetch(legacyRpc('notifications/initialized', undefined, bearer, null))).status, 202);
  const list = await endpoint.fetch(legacyRpc('tools/list', {}, bearer));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).result.tools.map(t => t.name), ['get_simulated_battery']);
  const call = await endpoint.fetch(legacyRpc('tools/call', { name: 'get_simulated_battery', arguments: {} }, bearer));
  assert.equal(call.status, 200);
  const content = JSON.parse((await call.json()).result.content[0].text);
  assert.deepEqual([content.source, content.battery_percent], ['SIMULATED',70]);
  assert.equal(outbound, 0);
});
test('legacy access remains gated by OAuth token and correct resource audience', async () => {
  const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name:'legacy',version:'1' } };
  assert.equal((await endpoint.fetch(legacyRpc('initialize', init))).status,401);
  assert.equal((await endpoint.fetch(legacyRpc('initialize', init, token({ aud:'wrong-resource' })))).status,401);
  assert.equal((await endpoint.fetch(legacyRpc('initialize', init, token()))).status,200);
  assert.equal(outbound,0);
});


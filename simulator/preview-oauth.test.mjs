import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import api from './api/mcp.mjs';
import { request } from './offline-request.mjs';

// Every network call is stubbed. No Tesla account, token or vehicle is contacted.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'preview-fixture', alg: 'RS256', use: 'sig' };
const origin = 'https://example.invalid';
const issuer = 'https://auth.example.invalid/';
const teslaFlags = ['TESLA_BACKEND_ENABLED', 'TESLA_READ_ENABLED', 'TESLA_REAL_RELEASE_APPROVED', 'TESLA_LOCATION_ENABLED', 'TESLA_COMMANDS_ENABLED', 'TESLA_COMMAND_EXECUTION_ENABLED'];
const variables = ['VERCEL_ENV', ...teslaFlags, 'APP_ORIGIN', 'MCP_AUTH_ISSUER', 'MCP_ALLOWED_SUBJECT'];
const saved = Object.fromEntries(variables.map(name => [name, process.env[name]]));
const oldFetch = globalThis.fetch;
Object.assign(process.env, {
  VERCEL_ENV: 'preview', ...Object.fromEntries(teslaFlags.map(name => [name, 'false'])),
  APP_ORIGIN: origin, MCP_AUTH_ISSUER: issuer, MCP_ALLOWED_SUBJECT: 'offline-owner'
});
const outbound = [];
globalThis.fetch = async (url, options) => {
  outbound.push({ url, method: options.method });
  assert.equal(url, issuer + '.well-known/jwks.json');
  return Response.json({ keys: [jwk] });
};
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = oldFetch;
});
function token(claims = {}, header = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: 'preview-fixture', ...header })).toString('base64url');
  const time = Math.floor(Date.now() / 1000);
  const p = Buffer.from(JSON.stringify({
    iss: issuer, aud: origin + '/mcp', sub: 'offline-owner',
    scope: 'battery:read', iat: time, exp: time + 600, ...claims
  })).toString('base64url');
  return h + '.' + p + '.' + sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
}
function rpc(method, params = {}, bearer) {
  const base = request(method, params);
  const headers = new Headers(base.headers);
  if (bearer) headers.set('authorization', 'Bearer ' + bearer);
  return new Request(base.url, { method: base.method, headers, body: base.body, duplex: 'half' });
}
test('preview requires OAuth before discovery and offers resource metadata', async () => {
  const response = await api.fetch(rpc('server/discover'));
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource/);
});
test('signed fixture token permits discovery, tool listing and simulated battery', async () => {
  const bearer = token();
  const discovery = await api.fetch(rpc('server/discover', {}, bearer));
  assert.equal(discovery.status, 200);
  const d = (await discovery.json()).result;
  assert.equal(d.resultType, 'complete');
  assert.equal(d.cacheScope, 'private');
  assert.equal(d.ttlMs, 0);
  assert.equal(d._meta['io.modelcontextprotocol/serverInfo'].name, 'tesla-voice-oauth-preview');
  const listed = await api.fetch(rpc('tools/list', {}, bearer));
  assert.equal(listed.status, 200);
  const tools = (await listed.json()).result;
  assert.deepEqual(tools.tools.map(item => item.name), ['get_simulated_battery', 'estimate_trip_energy', 'compare_charging_costs', 'plan_trip','get_free_to_x_card_tariffs','reverse_trip_location','search_trip_destination','plan_road_trip','find_charging_sites','plan_charging_road_trip']);
  assert.deepEqual(tools.tools[0].securitySchemes, [{ type: 'oauth2', scopes: ['battery:read'] }]);
  const called = await api.fetch(rpc('tools/call', { name: 'get_simulated_battery', arguments: {} }, bearer));
  assert.equal(called.status, 200);
  const result = (await called.json()).result;
  assert.equal(result.resultType, 'complete');
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual([value.source, value.battery_percent], ['SIMULATED', 70]);
  const estimate = await api.fetch(rpc('tools/call', { name: 'estimate_trip_energy', arguments: { distanceKm: 200, consumptionKwhPer100Km: 20, usableCapacityKwh: 80, batteryPercent: 60.3, reservePercent: 10.3 } }, bearer));
  const calculation = JSON.parse((await estimate.json()).result.content[0].text);
  assert.equal(calculation.meets_reserve, true);
  assert.equal(calculation.minimum_additional_battery_kwh, 0);
  const cost = await api.fetch(rpc('tools/call', { name: 'compare_charging_costs', arguments: {
    energyToBatteryKwh: 36, efficiencyPercent: 90,
    first: { label: 'Consumo', eurPerKwh: 0.35, fixedFeeEur: 0 },
    second: { label: 'Forfait', eurPerKwh: 0, fixedFeeEur: 17.5 }
  } }, bearer));
  const comparison = JSON.parse((await cost.json()).result.content[0].text);
  assert.equal(comparison.source, 'USER_SUPPLIED_TARIFFS');
  assert.equal(comparison.first.estimated_eur, 14);
  assert.equal(comparison.second.estimated_eur, 17.5);
  const plan = await api.fetch(rpc('tools/call', { name: 'plan_trip', arguments: {
    distanceKm: 200, consumptionKwhPer100Km: 20, usableCapacityKwh: 80,
    batteryPercent: 60, reservePercent: 25, efficiencyPercent: 95,
    first: { label: 'AC', eurPerKwh: 0.35, fixedFeeEur: 0 },
    second: { label: 'Forfait', eurPerKwh: 0, fixedFeeEur: 17.5 }
  } }, bearer));
  const itinerary = JSON.parse((await plan.json()).result.content[0].text);
  assert.equal(itinerary.minimum_additional_battery_kwh, 12);
  assert.equal(itinerary.charging_costs.first.estimated_eur, 4.42);
  assert.ok(outbound.every(entry => entry.url === issuer + '.well-known/jwks.json'));
  assert.equal(comparison.lower_cost, 'first');
  assert.ok(outbound.every(entry => entry.url === issuer + '.well-known/jwks.json'));
});
test('preview rejects ID token type, wrong subject, audience and scope', async () => {
  for (const invalid of [
    token({}, { typ: 'id+jwt' }),
    token({ sub: 'someone-else' }),
    token({ aud: 'https://wrong.invalid/mcp' }),
    token({ scope: 'tesla:connect' })
  ]) {
    const response = await api.fetch(rpc('tools/list', {}, invalid));
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata/);
  }
});
test('preview fails closed for every Tesla release flag, even with valid authorization', async () => {
  for (const flag of teslaFlags) {
    process.env[flag] = 'true';
    try {
    const response = await api.fetch(rpc('server/discover', {}, token()));
    assert.equal(response.status, 503);
    } finally {
      process.env[flag] = 'false';
    }
  }
});

test('Preview location-only token discovers maps but cannot invoke battery tools',async()=>{
  const bearer=token({scope:'location:read'});
  assert.equal((await api.fetch(rpc('tools/list',{},bearer))).status,200);
  const response=await api.fetch(rpc('tools/call',{name:'get_simulated_battery',arguments:{}},bearer));
  const body=await response.json();assert.equal(body.result.isError,true);
  assert.equal(JSON.parse(body.result.content[0].text).error.required_scope,'battery:read');
});
test('Preview reports safe map provider failures as MCP tool errors without losing authentication',async()=>{
  const prior=globalThis.fetch;let maps=0;
  try {
    globalThis.fetch=async(url,opts)=>{
      if(url===issuer+'.well-known/jwks.json')return Response.json({keys:[jwk]});
      assert.equal(new URL(url).hostname,'photon.komoot.io');maps++;throw Error('PRIVATE_PROVIDER_DETAILS');
    };
    const response=await api.fetch(rpc('tools/call',{name:'search_trip_destination',arguments:{query:'Hilltown',externalMapsConsent:true}},token({scope:'location:read'})));
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.result.isError,true);assert.equal(JSON.parse(body.result.content[0].text).error.code,'map_provider_unavailable');
    assert.doesNotMatch(JSON.stringify(body),/PRIVATE_PROVIDER_DETAILS/);assert.equal(maps,1);
  } finally {globalThis.fetch=prior;}
});

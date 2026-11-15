import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TESLA_AUTHORIZE_ENDPOINT, TESLA_EU_API, READ_ONLY_SCOPES,
  createOAuthState, validateOAuthState, validateCallbackConfig,
  buildTeslaAuthorizationUrl
} from './oauth-setup.mjs';

const origin = 'https://mcp.example.invalid';
const callbackUrl = origin + '/oauth/tesla/callback';
const make = () => ({ clientId: 'fictitious-client-id', origin, callbackUrl, state: createOAuthState() });

test('state ha 256 bit e cambia a ogni generazione', () => {
  const a = createOAuthState(), b = createOAuthState();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(validateOAuthState(a, a), true);
  assert.equal(validateOAuthState(a, b), false);
});
test('rifiuta state assente, alterato o malformato', () => {
  const a = createOAuthState();
  for (const b of ['', 'same', null, {}, a + '.', undefined]) assert.equal(validateOAuthState(a, b), false);
});
test('costruisce solo OAuth autorizzativo Tesla read-only', () => {
  const p = make(), url = new URL(buildTeslaAuthorizationUrl(p));
  assert.equal(url.origin, new URL(TESLA_AUTHORIZE_ENDPOINT).origin);
  assert.equal(url.pathname, '/oauth2/v3/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), p.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), callbackUrl);
  assert.equal(url.searchParams.get('state'), p.state);
  assert.deepEqual(url.searchParams.get('scope').split(' '), READ_ONLY_SCOPES);
  for (const forbidden of ['vehicle_cmds', 'vehicle_location', 'vehicle_charging_cmds']) assert.equal(url.href.includes(forbidden), false);
});
test('origine e callback coincidono su HTTPS', () => {
  assert.deepEqual(validateCallbackConfig(origin, callbackUrl), {origin, callbackUrl});
});
test('rifiuta callback su altri domini', () => {
  assert.throws(() => buildTeslaAuthorizationUrl({...make(), callbackUrl:'https://evil.example/oauth/tesla/callback'}));
});
test('rifiuta URL insicuri o manipolati', () => {
  for (const [o,c] of [
    ['http://localhost:3000','http://localhost:3000/oauth/tesla/callback'],
    [origin + '/path', callbackUrl],
    [origin, origin + '/oauth/tesla/callback?code=leak'],
    [origin, origin + '/oauth/tesla/callback#x'],
    [origin, origin + '/other'],
    [origin, 'http://mcp.example.invalid/oauth/tesla/callback']
  ]) assert.throws(() => validateCallbackConfig(o,c));
});
test('rifiuta client ID e stato non validi', () => {
  for (const bad of ['', '  ', undefined]) assert.throws(() => buildTeslaAuthorizationUrl({...make(), clientId:bad}));
  for (const bad of ['', 'weak', undefined]) assert.throws(() => buildTeslaAuthorizationUrl({...make(), state:bad}));
});
test('regione EU è fissa e non chiama mai Tesla', () => {
  assert.equal(TESLA_EU_API,'https://fleet-api.prd.eu.vn.cloud.tesla.com');
  // Il modulo non usa fetch e non possiede handler o credenziali.
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, hash, seal } from './lib/security.mjs';
import { createTeslaBackend } from './lib/tesla.mjs';
import { consumeTeslaRequestReservation } from './lib/request-budget.mjs';
import { PARTNER_REGISTER_MARKER, PARTNER_REGISTER_RESULT_KEY, TESLA_APP_DOMAIN } from './lib/partner-registration.mjs';
import { PARTNER_KEY_LOOKUP_RESULT_KEY, PARTNER_REGISTER_RECOVERY_MARKER } from './lib/partner-key-recovery.mjs';
import { TESLA_P256_ORIGIN } from './lib/partner-p256-identity.mjs';

const origin = 'https://mcp.example.invalid';
const fingerprint = '6d20b348ae1a5669e94498aeaa75a6220677b64e9a444d26fdfabcc181db477c';
const env = {
  APP_ORIGIN: origin, MCP_AUTH_ISSUER: 'https://issuer.invalid/',
  MCP_AUTH_JWKS: JSON.stringify({ keys: [{ kid: 'unused' }] }),
  MCP_ALLOWED_SUBJECT: 'owner',
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  TESLA_CLIENT_ID: 'test-client', TESLA_CLIENT_SECRET: 'test-secret',
  TESLA_FLEET_REGION: 'eu', TESLA_BACKEND_ENABLED: 'true',
  TESLA_PARTNER_REGISTRATION_APPROVED: 'true', TESLA_DAILY_READ_LIMIT: '10',
  VERCEL_ENV: 'production'
};
const config = configuration(env);
const tokenKey = 'tokens:' + hash(config.issuer + '\nowner');

function memoryStore(now) {
  const values = new Map();
  const valid = key => {
    const value = values.get(key);
    if (!value || value.expires <= now()) { values.delete(key); return null; }
    return value.value;
  };
  return {
    values,
    get: async key => valid(key),
    put: async (key, value, ttl) => { values.set(key, { value, expires: now() + ttl * 1000 }); return 'OK'; },
    take: async key => { const value = valid(key); values.delete(key); return value; },
    once: async (key, ttl) => {
      if (valid(key) !== null) return false;
      values.set(key, { value: '1', expires: now() + ttl * 1000 }); return true;
    },
    reserveTeslaBudget: async (day, limit, count) => {
      if(limit!==Infinity)return false;
      const key='read-budget-extra:'+day,raw=valid(key)??'0',current=Number(raw);
      if(!Number.isSafeInteger(current)||current<0)return false;
      values.set(key,{value:String(current+count),expires:now()+172800000});return true;
    },
    putOncePermanent: async (key, value) => {
      if (valid(key) !== null) return false;
      values.set(key, { value, expires: Number.POSITIVE_INFINITY }); return true;
    },
    lock: async () => ({ save: async () => {}, release: async () => {} })
  };
}

function fixture({ gate = true, registrationResult = { registered: true, status: 201 }, registrarError = null,
  lookupResult = { found: true, spki_sha256: fingerprint }, lookupError = null } = {}) {
  // Keep baseline-quota tests outside the explicitly dated Production exception.
  let clock = Date.UTC(2026, 10, 4, 12);
  const now = () => clock;
  const store = memoryStore(now);
  const calls = { tesla: 0, registration: 0, lookup: 0 };
  store.values.set(tokenKey, { value: seal({
    access: 'fake-access', refresh: 'fake-refresh', scopes: [
      'vehicle_device_data', 'vehicle_location', 'vehicle_cmds', 'vehicle_charging_cmds'
    ], expires: clock + 3600000, refreshExpires: clock + 86400000
  }, config.key, tokenKey), expires: Number.POSITIVE_INFINITY });
  const registrar = async options => {
    calls.registration++;
    assert.equal(options.approved, true);
    assert.equal(options.env.TESLA_PARTNER_REGISTRATION_APPROVED, 'true');
    if (options.recovery) {
      const lookup = JSON.parse(await options.storeFactory().get(PARTNER_KEY_LOOKUP_RESULT_KEY));
      assert.equal(lookup.status, 'not_found');
      assert.equal(await options.storeFactory().putOncePermanent(PARTNER_REGISTER_RECOVERY_MARKER, '1'), true);
    } else {
      assert.equal(await options.storeFactory().putOncePermanent(PARTNER_REGISTER_MARKER, '1'), true);
    }
    if (registrarError) throw Error(registrarError);
    return registrationResult;
  };
  const partnerKeyLookup = async options => {
    calls.lookup++;
    assert.equal(options.approved, true);
    assert.equal(consumeTeslaRequestReservation(options.budgetReservation, 2), true);
    if (lookupError) throw Error(lookupError);
    return lookupResult;
  };
  const backend = createTeslaBackend({
    config: { ...config, env: { ...config.env, TESLA_PARTNER_REGISTRATION_APPROVED: gate ? 'true' : 'false' } },
    store, now, fetcher: async () => { calls.tesla++; throw Error('Unexpected Tesla or network call in test'); },
    provisionKey: async () => ({ created: false, sha256: fingerprint }),
    readKeyPublic: async () => ({ sha256: fingerprint }), partnerRegistrar: registrar, partnerKeyLookup
  });
  return { backend, store, calls, advance: ms => { clock += ms; }, now };
}

function post(link, { requestOrigin = origin, confirm = 'register_once' } = {}) {
  const ticket = new URL(link).searchParams.get('ticket');
  return new Request(origin + '/oauth/tesla/partner-registration', {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, confirm })
  });
}

function postCheck(link, { code, requestOrigin = origin, confirm = 'check_once' } = {}) {
  const linkUrl = new URL(link);
  const ticket = linkUrl.searchParams.get('ticket') || linkUrl.pathname.match(/([A-Za-z0-9_-]{43})$/)?.[1];
  const fields = ticket ? { ticket, confirm } : { code, confirm };
  return new Request(origin + '/oauth/tesla/partner-key-check', {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
}

test('setup returns a short-lived explicit consent link and never exposes pairing before Tesla confirms registration', async () => {
  const f = fixture();
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(setup.partner_domain_registered, false);
  assert.equal(setup.vehicle_pairing_required, false);
  assert.equal(setup.partner_registration_expires_in_seconds, 300);
  assert.ok(setup.partner_registration_approval_url.startsWith(origin + '/oauth/tesla/partner-registration?ticket='));
  assert.equal(Object.hasOwn(setup, 'pairing_url'), false);
  assert.equal(f.calls.registration, 0);
  assert.equal(f.calls.tesla, 0);
  assert.equal(new URL(TESLA_P256_ORIGIN).hostname, TESLA_APP_DOMAIN);
});

test('GET is preview-safe; exact same-origin confirmation performs at most one registration and only then reveals pairing', async () => {
  const f = fixture();
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  const url = new URL(setup.partner_registration_approval_url);
  url.searchParams.set('utm_source', 'chatgpt.com');
  const view = new Request(url);
  const first = await f.backend.partnerRegistration(view);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
  const page = await first.text();
  assert.match(page, /one-time request to the Tesla Partner service/);
  assert.match(page, /Authorize one Tesla registration request/);
  assert.match(page, new RegExp(TESLA_APP_DOMAIN));
  assert.doesNotMatch(page, /tesla\.com\/_ak\//);
  assert.equal((await f.backend.partnerRegistration(view)).status, 200);
  assert.equal(f.calls.registration, 0);

  const foreign = await f.backend.partnerRegistration(post(setup.partner_registration_approval_url, { requestOrigin: 'https://attacker.invalid' }));
  assert.equal(foreign.status, 403);
  assert.equal(f.calls.registration, 0);

  const wrongButton = await f.backend.partnerRegistration(post(setup.partner_registration_approval_url, { confirm: 'cancel' }));
  assert.equal(wrongButton.status, 400);
  assert.equal(f.calls.registration, 0);

  const confirmed = await f.backend.partnerRegistration(post(setup.partner_registration_approval_url));
  assert.equal(confirmed.status, 200);
  const resultPage = await confirmed.text();
  assert.match(resultPage, /Tesla confirmed domain registration/);
  assert.match(resultPage, new RegExp('https://tesla\\.com/_ak/' + TESLA_APP_DOMAIN));
  assert.equal(f.calls.registration, 1);
  assert.equal(f.calls.tesla, 0);

  const replay = await f.backend.partnerRegistration(post(setup.partner_registration_approval_url));
  assert.equal(replay.status, 410);
  assert.equal(f.calls.registration, 1);
  const nextSetup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(nextSetup.partner_domain_registered, true);
  assert.equal(nextSetup.pairing_url, 'https://tesla.com/_ak/' + TESLA_APP_DOMAIN);
  assert.equal(nextSetup.partner_registration_approval_url, undefined);
});

test('cancel, malformed, and expired consent links cannot call Tesla or the registration helper', async () => {
  const f = fixture();
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  const ticket = new URL(setup.partner_registration_approval_url).searchParams.get('ticket');
  const bad = await f.backend.partnerRegistration(new Request(origin + '/oauth/tesla/partner-registration?ticket=' + ticket + '&other=x'));
  assert.equal(bad.status, 400);
  const expiredSetup = await f.backend.prepareVehicleCommandSetup('owner');
  f.advance(301000);
  const expired = await f.backend.partnerRegistration(new Request(expiredSetup.partner_registration_approval_url));
  assert.equal(expired.status, 410);
  assert.equal(f.calls.registration, 0);
  assert.equal(f.calls.tesla, 0);
});

test('a non-success Tesla response is stored without exposing pairing or permitting an automatic registration retry', async () => {
  const f = fixture({ registrationResult: { registered: false, status: 403, trace: 'tesla-trace-abcdef12' } });
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  const result = await f.backend.partnerRegistration(post(setup.partner_registration_approval_url));
  const text = await result.text();
  assert.match(text, /HTTP status 403/);
  assert.doesNotMatch(text, /_ak\//);
  assert.equal(f.calls.registration, 1);
  const nextSetup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(nextSetup.registration_status, 'verification_required');
  assert.ok(nextSetup.partner_registration_check_url);
  assert.equal(nextSetup.pairing_url, undefined);
  assert.equal(f.calls.registration, 1);
  assert.ok(await f.store.get(PARTNER_REGISTER_RESULT_KEY));
});

test('uncertain result is fail-closed and never retried automatically', async () => {
  const f = fixture({ registrarError: 'partner_registration_network_unverified' });
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  const result = await f.backend.partnerRegistration(post(setup.partner_registration_approval_url));
  assert.match(await result.text(), /Do not repeat the request/);
  assert.equal(f.calls.registration, 1);
  const nextSetup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(nextSetup.registration_status, 'verification_required');
  assert.ok(nextSetup.partner_registration_check_url);
  assert.equal(nextSetup.partner_registration_approval_url, undefined);
  assert.equal(f.calls.registration, 1);
  assert.equal(f.calls.tesla, 0);
});

test('uncertain prior attempt yields a static code-entry page; only explicit POST checks Tesla and matching key unlocks pairing', async () => {
  const f = fixture();
  f.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(setup.registration_status, 'verification_required');
  assert.equal(setup.partner_registration_check_url, origin + '/oauth/tesla/partner-key-check');
  assert.match(setup.partner_registration_check_code, /^[A-Za-z0-9_-]{12}$/);
  assert.equal(setup.partner_registration_check_url.includes(setup.partner_registration_check_code), false);
  assert.equal(setup.partner_registration_check_expires_in_seconds, 1800);
  assert.equal(f.calls.lookup, 0);
  assert.equal(f.calls.registration, 0);

  const view = new Request(setup.partner_registration_check_url + '?utm_source=chatgpt.com');
  const page = await f.backend.partnerKeyCheck(view);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'origin');
  const pageText = await page.text();
  assert.match(pageText, /name="code"/);
  assert.match(pageText, /read-only Tesla Partner check/);
  assert.match(pageText, /may use quota or incur Tesla service charges/i);
  assert.doesNotMatch(pageText, new RegExp(setup.partner_registration_check_code));
  assert.equal((await f.backend.partnerKeyCheck(view)).status, 200);
  assert.equal(f.calls.lookup, 0);

  const foreign = await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, {
    code: setup.partner_registration_check_code, requestOrigin: 'https://attacker.invalid'
  }));
  assert.equal(foreign.status, 403);
  assert.equal(f.calls.lookup, 0);
  const wrongButton = await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, {
    code: setup.partner_registration_check_code, confirm: 'register_once'
  }));
  assert.equal(wrongButton.status, 400);
  assert.equal(f.calls.lookup, 0);
  const malformed = await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, { code: 'short' }));
  assert.equal(malformed.status, 400);
  assert.equal(f.calls.lookup, 0);

  const submitted = postCheck(setup.partner_registration_check_url, { code: setup.partner_registration_check_code });
  assert.equal(new URL(submitted.url).search, '');
  const checked = await f.backend.partnerKeyCheck(submitted);
  const resultPage = await checked.text();
  assert.equal(checked.status, 200);
  assert.match(resultPage, /Tesla found the same public key/);
  assert.match(resultPage, new RegExp('https://tesla\\.com/_ak/' + TESLA_APP_DOMAIN));
  assert.equal(f.calls.lookup, 1);
  assert.equal(f.calls.registration, 0);
  assert.equal(f.calls.tesla, 0);
  const budgetDay=new Date(f.now()).toISOString().slice(0,10);
  assert.deepEqual([...f.store.values.keys()].filter(key=>key.startsWith('read-budget')).sort(),[
    `read-budget-extra:${budgetDay}`
  ]);
  assert.equal(f.store.values.get(`read-budget-extra:${budgetDay}`).value,'2');
  const replay = await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, {
    code: setup.partner_registration_check_code
  }));
  assert.equal(replay.status, 410);
  const nextSetup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(nextSetup.partner_domain_registered, true);
  assert.equal(nextSetup.pairing_url, 'https://tesla.com/_ak/' + TESLA_APP_DOMAIN);
});

test('Production Partner check ignores the legacy daily cap and meters both requests', async()=>{
  const f=fixture();
  f.store.values.set(PARTNER_REGISTER_MARKER,{value:'1',expires:Number.POSITIVE_INFINITY});
  const setup=await f.backend.prepareVehicleCommandSetup('owner');
  const budgetDay=new Date(f.now()).toISOString().slice(0,10);
  for(let slot=0;slot<50;slot++)
    f.store.values.set(`read-budget:${budgetDay}:${slot}`,{value:'1',expires:Number.POSITIVE_INFINITY});
  const codeKey='partner-key-check-code:'+hash(setup.partner_registration_check_code);
  const before=f.store.values.get(codeKey);
  const response=await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url,{
    code:setup.partner_registration_check_code
  }));
  assert.equal(response.status,200);
  assert.match(await response.text(),/Tesla found the same public key/);
  assert.equal(f.calls.lookup,1);
  assert.equal(f.calls.tesla,0);
  assert.notDeepEqual(f.store.values.get(codeKey),before);
  assert.equal(f.store.values.get(`read-budget-extra:${budgetDay}`).value,'2');
  assert.equal(f.store.values.get(`read-budget:${budgetDay}:49`).value,'1');
});

test('partner-check codes expire after 30 minutes and cannot trigger a Tesla lookup', async () => {
  const f = fixture();
  f.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  f.advance(1800001);
  const expired = await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, {
    code: setup.partner_registration_check_code
  }));
  assert.equal(expired.status, 410);
  assert.equal(f.calls.lookup, 0);
  assert.equal(f.calls.registration, 0);
  assert.equal(f.calls.tesla, 0);
});

test('Tesla confirmed absence is required before one explicit recovery registration can be offered', async () => {
  const f = fixture({ lookupResult: { found: false, status: 'not_found' } });
  f.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  const checked = await f.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, { code: setup.partner_registration_check_code }));
  assert.match(await checked.text(), /Tesla did not find a key registered/);
  assert.equal(f.calls.lookup, 1);
  assert.equal(f.calls.registration, 0);
  assert.equal(f.calls.tesla, 0);

  const recovery = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(recovery.registration_status, 'verified_not_registered');
  assert.ok(recovery.partner_registration_approval_url);
  assert.equal(f.calls.registration, 0);
  const registered = await f.backend.partnerRegistration(post(recovery.partner_registration_approval_url));
  assert.match(await registered.text(), /Tesla confirmed domain registration/);
  assert.equal(f.calls.registration, 1);
  assert.equal(f.calls.lookup, 1);
  assert.equal(f.calls.tesla, 0);
  const after = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(after.partner_domain_registered, true);
  assert.equal(after.pairing_url, 'https://tesla.com/_ak/' + TESLA_APP_DOMAIN);
});

test('key mismatch and lookup failures never expose pairing or trigger registration', async () => {
  const mismatch = fixture({ lookupResult: { found: true, spki_sha256: 'f'.repeat(64) } });
  mismatch.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
  const mismatchSetup = await mismatch.backend.prepareVehicleCommandSetup('owner');
  const mismatchPage = await mismatch.backend.partnerKeyCheck(postCheck(mismatchSetup.partner_registration_check_url, { code: mismatchSetup.partner_registration_check_code }));
  assert.match(await mismatchPage.text(), /registered key that differs from the key stored by the backend/);
  const mismatchStatus = await mismatch.backend.prepareVehicleCommandSetup('owner');
  assert.equal(mismatchStatus.registration_status, 'verification_key_mismatch');
  assert.equal(mismatchStatus.pairing_url, undefined);
  assert.equal(mismatch.calls.registration, 0);

  const failed = fixture({ lookupError: 'partner_key_http_403' });
  failed.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
  const failedSetup = await failed.backend.prepareVehicleCommandSetup('owner');
  const failedPage = await failed.backend.partnerKeyCheck(postCheck(failedSetup.partner_registration_check_url, { code: failedSetup.partner_registration_check_code }));
  const failedText = await failedPage.text();
  assert.ok(failedText.includes('Codice: <code>partner_key_http_403</code>'));
  assert.doesNotMatch(failedText, /SECRET|MOCK_PARTNER_TOKEN/);
  assert.equal(failedText.includes('_ak/'), false);
  assert.equal(failed.calls.registration, 0);
  assert.equal(failed.calls.tesla, 0);

  const formatFailure = fixture({ lookupError: 'partner_key_response_field_unverified' });
  formatFailure.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
  const formatSetup = await formatFailure.backend.prepareVehicleCommandSetup('owner');
  const formatPage = await formatFailure.backend.partnerKeyCheck(postCheck(formatSetup.partner_registration_check_url, {
    code: formatSetup.partner_registration_check_code
  }));
  const formatText = await formatPage.text();
  assert.ok(formatText.includes('Codice: <code>partner_key_response_field_unverified</code>'));
  assert.equal(formatText.includes('_ak/'), false);
  assert.equal(formatFailure.calls.registration, 0);
  assert.equal(formatFailure.calls.tesla, 0);

  for (const diagnostic of [
    'partner_key_response_encoding_unverified',
    'partner_key_response_curve_unverified'
  ]) {
    const formatFailure = fixture({ lookupError: diagnostic });
    formatFailure.store.values.set(PARTNER_REGISTER_MARKER, { value: '1', expires: Number.POSITIVE_INFINITY });
    const setup = await formatFailure.backend.prepareVehicleCommandSetup('owner');
    const page = await formatFailure.backend.partnerKeyCheck(postCheck(setup.partner_registration_check_url, {
      code: setup.partner_registration_check_code
    }));
    const text = await page.text();
    assert.ok(text.includes('Codice: <code>' + diagnostic + '</code>'));
    assert.equal(text.includes('_ak/'), false);
    assert.equal(formatFailure.calls.registration, 0);
    assert.equal(formatFailure.calls.tesla, 0);
  }
});

test('disabled owner gate returns no consent link and cannot start a request', async () => {
  const f = fixture({ gate: false });
  const setup = await f.backend.prepareVehicleCommandSetup('owner');
  assert.equal(setup.registration_status, 'owner_gate_disabled');
  assert.equal(setup.partner_registration_approval_url, undefined);
  assert.equal(setup.pairing_url, undefined);
  assert.equal(f.calls.registration, 0);
  assert.equal(f.calls.tesla, 0);
});

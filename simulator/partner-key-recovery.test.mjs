import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import {
  lookupRegisteredPartnerKey, validatePartnerKeyResponse,
  TESLA_PARTNER_TOKEN_ENDPOINT, TESLA_EU_FLEET_API, REGISTERED_TESLA_DOMAIN
} from './lib/partner-key-recovery.mjs';
import { reserveTeslaRequests } from './lib/request-budget.mjs';

const env = {
  VERCEL_ENV: 'production',
  TESLA_PARTNER_REGISTRATION_APPROVED: 'true',
  APP_ORIGIN: 'https://' + REGISTERED_TESLA_DOMAIN,
  TESLA_FLEET_REGION: 'eu',
  TESLA_CLIENT_ID: 'fake-partner-client',
  TESLA_CLIENT_SECRET: 'SECRET_FIXTURE_DO_NOT_USE'
};
const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
  .export({ format: 'pem', type: 'spki' });
const registeredResponse = { response: { public_key: pem } };
const lookupWithBudget = options => {
  const keys = new Set();
  const store = { get: async key => keys.has(key) ? '1' : null, reserveTeslaBudget: async (day,limit,count) => {
    if(limit!==Infinity)return false;
    keys.add('read-budget-extra:'+day);return true;
  }, once: async key => {
    if (keys.has(key)) return false;
    keys.add(key); return true;
  }};
  return lookupRegisteredPartnerKey({
    ...options,
    reserveRequests: options.reserveRequests ?? (async count => {
      assert.equal(count, 2);
      return reserveTeslaRequests({store,env:{...options.env,TESLA_DAILY_READ_LIMIT:'10'},count});
    })
  });
};

test('Partner lookup cannot contact Tesla without explicit one-time and Production approvals', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; throw Error('Must not contact remote API'); };
  for (const [cfg, approved] of [
    [env, false],
    [{ ...env, TESLA_PARTNER_REGISTRATION_APPROVED: 'false' }, true],
    [{ ...env, VERCEL_ENV: 'preview' }, true],
    [{ ...env, APP_ORIGIN: 'http://unrelated.invalid' }, true],
    [{ ...env, TESLA_CLIENT_SECRET: '' }, true]
  ]) {
    await assert.rejects(lookupWithBudget({ env: cfg, approved, fetcher }));
  }
  assert.equal(requests, 0);
});

test('Partner lookup requires and reserves both shared-budget slots before any Tesla call', async () => {
  let requests = 0, reserved = 0;
  const keys = new Set();
  const store = { get: async key => keys.has(key) ? '1' : null, reserveTeslaBudget: async (day,limit,count) => {
    if(limit!==Infinity)return false;
    keys.add('read-budget-extra:'+day);return true;
  }, once: async key => {
    if (keys.has(key)) return false;
    keys.add(key); return true;
  }};
  const fetcher = async () => { requests++; return Response.json({ access_token: 'MOCK_PARTNER_TOKEN' }); };
  await assert.rejects(lookupRegisteredPartnerKey({ env, approved: true, fetcher }), /partner_key_budget_unavailable/);
  assert.equal(requests, 0);
  await assert.rejects(lookupRegisteredPartnerKey({ env, approved: true, budgetReservation: {}, fetcher }), /partner_key_budget_unavailable/);
  assert.equal(requests, 0);
  const result = await lookupRegisteredPartnerKey({
    env, approved: true,
    reserveRequests: async count => {
      reserved += count; assert.equal(requests, 0);
      return reserveTeslaRequests({store,env:{...env,TESLA_DAILY_READ_LIMIT:'10'},count});
    },
    fetcher: async () => {
      requests++;
      return requests === 1 ? Response.json({ access_token: 'MOCK_PARTNER_TOKEN' })
        : Response.json(registeredResponse);
    }
  });
  assert.equal(result.found, true);
  assert.equal(reserved, 2);
  assert.equal(requests, 2);
});

test('Single read-only Partner public-key check uses EU region and never exposes tokens', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    if (calls.length === 1) return Response.json({ access_token: 'MOCK_PARTNER_TOKEN' });
    return Response.json(registeredResponse);
  };
  const result = await lookupWithBudget({ env, approved: true, fetcher });
  assert.equal(result.found, true);
  assert.equal(result.public_key_pem_base64, Buffer.from(pem).toString('base64'));
  assert.match(result.spki_sha256, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, TESLA_PARTNER_TOKEN_ENDPOINT);
  assert.equal(calls[0].options.method, 'POST');
  const tokenGrant = new URLSearchParams(calls[0].options.body);
  assert.equal(tokenGrant.get('grant_type'), 'client_credentials');
  assert.equal(tokenGrant.get('audience'), TESLA_EU_FLEET_API);
  assert.equal(tokenGrant.get('client_id'), env.TESLA_CLIENT_ID);
  assert.equal(tokenGrant.get('client_secret'), env.TESLA_CLIENT_SECRET);
  assert.deepEqual(tokenGrant.get('scope')?.split(' '), ['openid','vehicle_device_data']);
  assert.doesNotMatch(tokenGrant.get('scope'), /vehicle_cmds|vehicle_charging_cmds|vehicle_location/);
  assert.equal(calls[1].url, TESLA_EU_FLEET_API + '/api/1/partner_accounts/public_key?domain=' + REGISTERED_TESLA_DOMAIN);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.headers.authorization, 'Bearer MOCK_PARTNER_TOKEN');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  assert.equal(calls[1].options.headers.accept, 'application/json');
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_FIXTURE|MOCK_PARTNER_TOKEN/);
});

test('Partner response accepts equivalent PEM and SPKI encodings but canonicalizes to the hosted P-256 key', () => {
  const expected = validatePartnerKeyResponse(registeredResponse);
  const der = createPublicKey(pem).export({ format: 'der', type: 'spki' });
  const equivalents = [
    Buffer.from(pem, 'utf8').toString('base64'),
    pem.replace(/\n/g, '\\n'),
    der.toString('base64')
  ];
  for (const public_key of equivalents) {
    const result = validatePartnerKeyResponse({ response: { public_key } });
    assert.equal(result.found, true);
    assert.equal(result.public_key_pem_base64, expected.public_key_pem_base64);
    assert.equal(result.spki_sha256, expected.spki_sha256);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE/);
  }
});

test('Tesla public protocol point vector normalizes to the identical P-256 SPKI fingerprint', () => {
  // Public test vector only, from Tesla vehicle-command/pkg/protocol/protocol.md.
  const publicPem = '-----BEGIN PUBLIC KEY-----\n' +
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEx6H0cThIaqRymXFJSHjTOxok45Vx\n' +
    '90im4WxZVbPYd9OmqqDpVRZkdK9dMsQQ9DmiI0E3rRuwhf1OiBPJWPEdlw==\n' +
    '-----END PUBLIC KEY-----\n';
  const point = '04c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d97';
  const expected = validatePartnerKeyResponse({ response: { public_key: publicPem } });
  for (const public_key of [point, point.toUpperCase()]) {
    assert.deepEqual(validatePartnerKeyResponse({ response: { public_key } }), expected);
  }
});

test('Hex parser rejects invalid points, lengths, prefixes and private scalar values with safe metadata', () => {
  for (const public_key of [
    '04' + '00'.repeat(64),
    '04' + 'ff'.repeat(64),
    '02' + '01'.repeat(32),
    '04' + '01'.repeat(63),
    '04' + '01'.repeat(65),
    '01'.repeat(32),
    '04' + 'z'.repeat(128)
  ]) {
    assert.throws(() => validatePartnerKeyResponse({ response: { public_key } }), error =>
      error.message === 'partner_key_response_encoding_unverified' &&
      ['hex', 'base64', 'other'].includes(error.publicKeyShape) &&
      error.publicKeyLength === public_key.length &&
      !JSON.stringify(error).includes(public_key));
  }
});

test('Missing Partner key is reported without registering a new one or retrying', async () => {
  for (const [status, expected] of [[404, 'not_found'], [412, 'partner_not_registered']]) {
    const urls = [];
    const fetcher = async (url) => {
      urls.push(url);
      return urls.length === 1
        ? Response.json({ access_token: 'MOCK_PARTNER_TOKEN' })
        : new Response(null, { status });
    };
    const result = await lookupWithBudget({ env, approved: true, fetcher });
    assert.deepEqual(result, { found: false, status: expected });
    assert.equal(urls.length, 2);
    assert.ok(urls.every(u => !u.includes('/api/1/vehicles')));
    assert.ok(urls.every(u => !u.endsWith('/api/1/partner_accounts')));
  }
});

test('Tesla Fleet API 406 is diagnosed by status only, without response body or secrets', async () => {
  let count=0;
  const fetcher=async (url,opts) => {
    count++;
    if(url === TESLA_PARTNER_TOKEN_ENDPOINT) return Response.json({ access_token:'MOCK_PARTNER_TOKEN' });
    assert.equal(opts.headers['content-type'],'application/json');
    return Response.json({error:'SECRET_UPSTREAM_PAYLOAD'}, {status:406});
  };
  await assert.rejects(lookupWithBudget({env,approved:true,fetcher}),
    e => e.message === 'partner_key_http_406' && !e.message.includes('SECRET'));
  assert.equal(count,2);
});

test('Upstream failures and invalid PEM remain sanitized; no accidental rotation', async () => {
  const failing = async (url) => url === TESLA_PARTNER_TOKEN_ENDPOINT
    ? Response.json({ access_token: 'MOCK_PARTNER_TOKEN' })
    : Response.json({ error: 'PRIVATE_PROVIDER_BODY' }, { status: 403 });
  await assert.rejects(
    lookupWithBudget({ env, approved: true, fetcher: failing }),
    e => e.message === 'partner_key_http_403' && !e.message.includes('PRIVATE')
  );
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
    .export({ format: 'pem', type: 'spki' });
  const privatePem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => validatePartnerKeyResponse({ response: { public_key: wrongCurve } }),
    /partner_key_response_curve_unverified/);
  for (const public_key of [privatePem, 'INVALID'])
    assert.throws(() => validatePartnerKeyResponse({ response: { public_key } }),
      /partner_key_response_encoding_unverified/);
  for (const input of [{ response: {} }, {}])
    assert.throws(() => validatePartnerKeyResponse(input), /partner_key_response_field_unverified/);
  assert.equal(createPublicKey(pem).asymmetricKeyType, 'ec');
});

test('Safe Tesla 403 trace metadata excludes arbitrary provider error and descriptions', async () => {
  let n=0;
  const fetcher=async () => ++n===1
    ? Response.json({access_token:'MOCK_PARTNER_TOKEN'})
    : Response.json({error:'insufficient_scope',error_description:'PRIVATE_SECRET_PROVIDER_RESPONSE'},
       {status:403,headers:{'x-txid':'tesla-trace-1234567'}});
  await assert.rejects(
    lookupWithBudget({env,approved:true,fetcher}),
    e => e.message==='partner_key_http_403' && e.teslaError==='insufficient_scope'
      && e.teslaTxid==='tesla-trace-1234567'
      && !JSON.stringify(e).includes('PRIVATE')
  );
  assert.equal(n,2);
});

test('Untrusted Tesla metadata cannot leak unexpected error codes or trace headers', async () => {
  let n=0;
  const fetcher=async () => ++n===1
    ? Response.json({access_token:'MOCK_PARTNER_TOKEN'})
    : Response.json({error:'PRIVATE_SECRET_CODE',error_description:'PRIVATE_SECRET_BODY'},
       {status:403,headers:{'x-txid':'bad header value : SECRET'}});
  await assert.rejects(
    lookupWithBudget({env,approved:true,fetcher}),
    e => e.message==='partner_key_http_403'
      && e.teslaError===undefined && e.teslaTxid===undefined
  );
  assert.equal(n,2);
});

test('HTTP status and PEM format errors are distinguishable without leaking partner payload', async () => {
  for (const status of [400, 402, 403, 421, 429, 500, 503]) {
    let count = 0;
    const fetcher = async () => {
      count++;
      return count === 1 ? Response.json({ access_token: 'SECRET_PARTNER_TOKEN' })
        : Response.json({ error: 'PRIVATE_PROVIDER_BODY' }, { status });
    };
    await assert.rejects(
      lookupWithBudget({ env, approved: true, fetcher }),
      err => err.message === 'partner_key_http_' + status
    );
    assert.equal(count, 2);
  }
  let count = 0;
  const malformed = async () => {
    count++;
    return count === 1 ? Response.json({ access_token: 'SECRET_PARTNER_TOKEN' })
      : Response.json({ response: { public_key: 'PRIVATE_INVALID_KEY_FORMAT' } });
  };
  await assert.rejects(
    lookupWithBudget({ env, approved: true, fetcher: malformed }),
    err => err.message === 'partner_key_response_encoding_unverified'
  );
  assert.equal(count, 2);
});


test('HTTP 200 response diagnostics distinguish JSON, field, and key failures without exposing payloads', async () => {
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
    .export({ format: 'pem', type: 'spki' });
  const cases = [
    ['partner_key_response_json_unverified', () => new Response('PRIVATE_INVALID_JSON')],
    ['partner_key_response_field_unverified', () => Response.json({ response: {} })],
    ['partner_key_response_encoding_unverified', () => Response.json({ response: { public_key: 'PRIVATE_INVALID_KEY' } })],
    ['partner_key_response_curve_unverified', () => Response.json({ response: { public_key: wrongCurve } })]
  ];
  for (const [expected, makeResponse] of cases) {
    let calls = 0;
    const fetcher = async () => ++calls === 1
      ? Response.json({ access_token: 'SECRET_PARTNER_TOKEN' })
      : makeResponse();
    await assert.rejects(lookupWithBudget({ env, approved: true, fetcher }), err =>
      err.message === expected && !JSON.stringify(err).includes('PRIVATE') &&
      !JSON.stringify(err).includes('SECRET_PARTNER_TOKEN'));
    assert.equal(calls, 2);
  }
});

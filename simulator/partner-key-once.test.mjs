import test from 'node:test';
import assert from 'node:assert/strict';
import { runPartnerKeyOnce, CHECK_MARKER } from './lib/partner-key-once.mjs';
import { consumeTeslaRequestReservation } from './lib/request-budget.mjs';

const env = {
  VERCEL_ENV: 'production',
  APP_ORIGIN: 'https://mcp.example.invalid',
  TESLA_FLEET_REGION: 'eu',
  TESLA_CLIENT_ID: 'fixture-client',
  TESLA_CLIENT_SECRET: 'FIXTURE_SECRET_NEVER_PRINT',
  TESLA_DAILY_READ_LIMIT: '10',
  TOKEN_STORE_REST_URL: 'https://store.invalid',
  TOKEN_STORE_REST_TOKEN: 'FIXTURE_STORAGE_TOKEN'
};
function oneShotStore(){
  const values=new Set(),counters=new Map();
  return {
    get:async key=>counters.get(key)??(values.has(key)?'1':null),
    once:async key=>{if(values.has(key))return false;values.add(key);return true;},
    reserveTeslaBudget:async(day,limit,count)=>{
      if(limit!==Infinity)return false;
      const key='read-budget-extra:'+day,current=Number(counters.get(key)??'0');
      if(!Number.isSafeInteger(current)||current<0)return false;
      counters.set(key,String(current+count));return true;
    }
  };
}

test('Preview and incorrect Production config execute no outbound calls and no storage writes', async () => {
  let reservations = 0, calls = 0;
  const storeFactory = () => { reservations++; throw Error('must not be used'); };
  const lookup = async () => { calls++; throw Error('must not be used'); };
  for (const cfg of [
    { ...env, VERCEL_ENV: 'preview' },
    { ...env, VERCEL_ENV: 'development' },
    { ...env, APP_ORIGIN: 'http://unrelated.invalid' },
    { ...env, TESLA_FLEET_REGION: 'na' },
    { ...env, TESLA_CLIENT_ID: '' },
    { ...env, TOKEN_STORE_REST_TOKEN: '' }
  ]) {
    await runPartnerKeyOnce({env:cfg,storeFactory,lookup,emit:()=>{}});
  }
  assert.equal(reservations,0);
  assert.equal(calls,0);
});

test('One durable reservation precedes a single Partner lookup and prevents replay', async () => {
  let reservations=0,lookupCount=0;
  const messages=[];
  const values=new Map();
  const store={
    get:async key=>values.get(key)??null,
    reserveTeslaBudget:async(day,limit,count)=>{
      if(limit!==Infinity)return false;
      const key='read-budget-extra:'+day,current=Number(values.get(key)??'0');
      if(!Number.isSafeInteger(current)||current<0)return false;
      values.set(key,String(current+count));reservations+=count;return true;
    },
    once:async (key,ttl)=>{
      assert.ok(key===CHECK_MARKER||key.startsWith('read-budget:'));
      assert.equal(ttl,key===CHECK_MARKER?315360000:172800);
      if(values.has(key))return false;
      values.set(key,'1');reservations++;return true;
    }
  };
  const storeFactory=()=>store;
  const lookup=async ({env:lookupEnv,approved,budgetReservation}) => {
    assert.equal(lookupEnv.TESLA_PARTNER_KEY_LOOKUP_APPROVED,'true');
    assert.equal(approved,true);
    assert.equal(consumeTeslaRequestReservation(budgetReservation,2),true);
    lookupCount++;
    return {found:false,status:'not_found'};
  };
  const first=await runPartnerKeyOnce({env,storeFactory,lookup,emit:x=>messages.push(x)});
  const second=await runPartnerKeyOnce({env,storeFactory,lookup,emit:x=>messages.push(x)});
  assert.equal(first,'not_found');
  assert.equal(second,'already_reserved_no_network');
  assert.equal(lookupCount,1);
  assert.equal(reservations,3); // two shared-budget slots and one permanent marker
  assert.ok(messages.includes('TESLA_PARTNER_CHECK=not_found'));
  assert.doesNotMatch(messages.join(' '),/FIXTURE_SECRET|FIXTURE_STORAGE_TOKEN/);
});

test('Storage reservation failure blocks Tesla without leaking error details', async () => {
  let called=0;const messages=[];
  const status=await runPartnerKeyOnce({env,
    storeFactory:()=>({get:async()=>null,once:async()=>{throw Error('PRIVATE_STORE_ERROR');}}),
    lookup:async()=>{called++;throw Error('should not be called');},
    emit:x=>messages.push(x)
  });
  assert.equal(status,'request_budget_unavailable');
  assert.equal(called,0);
  assert.doesNotMatch(messages.join(' '),/PRIVATE/);
});

test('Only public P-256-derived fields may be emitted; tokens and private credentials never appear',async()=>{
  const messages=[];
  const result=await runPartnerKeyOnce({env,
    storeFactory:oneShotStore,
    lookup:async()=>({
      found:true,
      spki_sha256:'a'.repeat(64),
      public_key_pem_base64:'PUBLIC_PEM_FIXTURE_ONLY'
    }),
    emit:x=>messages.push(x)
  });
  assert.equal(result,'public_key_found');
  assert.equal(messages.length,3);
  assert.ok(messages.includes('TESLA_PARTNER_CHECK=public_key_found'));
  assert.doesNotMatch(messages.join(' '),/FIXTURE_SECRET_NEVER_PRINT|FIXTURE_STORAGE_TOKEN/);
});

test('One-shot diagnostic emits only allowlisted status, error enum and Tesla trace ID',async()=>{
  const messages=[];
  const upstream=Error('partner_key_http_403');
  upstream.teslaError='insufficient_scope';
  upstream.teslaTxid='tesla-trace-1234567';
  const result=await runPartnerKeyOnce({env,
    storeFactory:oneShotStore,
    lookup:async()=>{throw upstream;},
    emit:x=>messages.push(x)
  });
  assert.equal(result,'partner_key_http_403');
  assert.deepEqual(messages, [
    'TESLA_PARTNER_CHECK=partner_key_http_403',
    'TESLA_PARTNER_ERROR_ENUM=insufficient_scope',
    'TESLA_PARTNER_TRACE_ID=tesla-trace-1234567'
  ]);
  assert.doesNotMatch(messages.join(' '),/FIXTURE_SECRET|FIXTURE_STORAGE_TOKEN/);
});

test('Provider errors are sanitized and no reattempt occurs on one-time reservation',async()=>{
  const messages=[];
  const result=await runPartnerKeyOnce({env,
    storeFactory:oneShotStore,
    lookup:async()=>{throw Error('PRIVATE_PROVIDER_PAYLOAD');},
    emit:x=>messages.push(x)
  });
  assert.equal(result,'unexpected_failure');
  assert.doesNotMatch(messages.join(' '),/PRIVATE/);
});

test('Production fails closed when the store lacks atomic unlimited-budget reservation',async()=>{
  const values=new Set(),messages=[];let lookupCount=0;
  const store={get:async key=>values.has(key)?'1':null,once:async key=>{
    if(values.has(key))return false;
    values.add(key);return true;
  }};
  const status=await runPartnerKeyOnce({env,
    storeFactory:()=>store,lookup:async()=>{lookupCount++;return {found:false,status:'not_found'};},
    emit:line=>messages.push(line)});
  assert.equal(status,'request_budget_unavailable');
  assert.equal(lookupCount,0);
  assert.equal(values.has(CHECK_MARKER),false);
  assert.ok(messages.includes('TESLA_PARTNER_CHECK=request_budget_unavailable'));
});

test('Future diagnostics print only sanitized HTTP status without upstream secrets', async () => {
  const lines = [];
  const result = await runPartnerKeyOnce({
    env, storeFactory: oneShotStore,
    lookup: async () => { throw Error('partner_key_http_421'); },
    emit: line => lines.push(line)
  });
  assert.equal(result, 'partner_key_http_421');
  assert.deepEqual(lines, ['TESLA_PARTNER_CHECK=partner_key_http_421']);
  assert.doesNotMatch(JSON.stringify(lines), /FIXTURE_SECRET_NEVER_PRINT|FIXTURE_STORAGE_TOKEN/);
});


test('One-shot lookup preserves safe response-format diagnostics only', async () => {
  for (const code of [
    'partner_key_response_encoding_unverified',
    'partner_key_response_curve_unverified'
  ]) {
    const lines = [];
    const result = await runPartnerKeyOnce({
      env, storeFactory: oneShotStore,
      lookup: async () => { throw Error(code); },
      emit: line => lines.push(line)
    });
    assert.equal(result, code);
    assert.deepEqual(lines, ['TESLA_PARTNER_CHECK=' + code]);
    assert.doesNotMatch(JSON.stringify(lines), /FIXTURE_SECRET_NEVER_PRINT|FIXTURE_STORAGE_TOKEN/);
  }
});

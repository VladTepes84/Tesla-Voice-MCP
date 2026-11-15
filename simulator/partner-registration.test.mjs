import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  registerTeslaPartnerEUOnce, PARTNER_REGISTER_MARKER,TESLA_APP_DOMAIN
} from './lib/partner-registration.mjs';
import { TESLA_EU_FLEET_API, TESLA_PARTNER_TOKEN_ENDPOINT,
  PARTNER_KEY_LOOKUP_RESULT_KEY, PARTNER_REGISTER_RECOVERY_MARKER } from './lib/partner-key-recovery.mjs';
import { TESLA_PUBLIC_KEY_PATH } from './api/tesla-public-key.mjs';
import { TESLA_P256_ORIGIN } from './lib/partner-p256-identity.mjs';

const pub=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey
  .export({format:'pem',type:'spki'});
const env={
  VERCEL_ENV:'production',APP_ORIGIN:TESLA_P256_ORIGIN,TESLA_FLEET_REGION:'eu',
  TESLA_PARTNER_REGISTRATION_APPROVED:'true',
  TESLA_CLIENT_ID:'fake-client',TESLA_CLIENT_SECRET:'FAKE_SECRET_NEVER_LOG',
  TESLA_DAILY_READ_LIMIT:'10'
};
function fixture(overrides={}) {
  const state={queries:[],reserved:0,budgetSlots:0,read:0};
  const saved=new Map();
  if(overrides.existingMarker)saved.set(PARTNER_REGISTER_MARKER,'1');
  if(overrides.lookupStatus)saved.set(PARTNER_KEY_LOOKUP_RESULT_KEY,
    JSON.stringify({status:overrides.lookupStatus,key_matches:false}));
  const store={get:async key=>saved.get(key)??null,once:async key=>{
    if(saved.has(key))return false;
    saved.set(key,'1');state.budgetSlots++;return true;
  },reserveTeslaBudget:async(day,limit,count)=>{
    if(limit===Infinity){
      const key='read-budget-extra:'+day,raw=saved.get(key)??'0',current=Number(raw);
      if(!Number.isSafeInteger(current)||current<0)return false;
      saved.set(key,String(current+count));state.budgetSlots+=count;return true;
    }
    let free=0;
    for(let i=0;i<50;i++)if(saved.get(`read-budget:${day}:${i}`)==='1'){}else if(i<limit)free++;
    if(free<count)return false;
    for(let i=0;i<limit&&count>0;i++)if(!saved.has(`read-budget:${day}:${i}`)){saved.set(`read-budget:${day}:${i}`,'1');count--;state.budgetSlots++;}
    return count===0;
  },putOncePermanent:async (key,value)=>{
    assert.ok([PARTNER_REGISTER_MARKER,PARTNER_REGISTER_RECOVERY_MARKER].includes(key));
    assert.equal(value,'1');
    if(saved.has(key))return false;
    saved.set(key,value);state.reserved++;return true;
  }};
  const readPublic=async()=>{state.read++;return {publicPem:pub,sha256:'a'.repeat(64)};};
  const fetcher=async(url,opt)=>{
    state.queries.push({url,opt});
    if(url===TESLA_P256_ORIGIN+TESLA_PUBLIC_KEY_PATH)
      return new Response(overrides.hostedPem??pub,{status:overrides.publicStatus??200,
        headers:{'content-type':'text/plain'}});
    if(url===TESLA_PARTNER_TOKEN_ENDPOINT)
      return Response.json({access_token:'FAKE_TOKEN_NEVER_LOG'},{status:overrides.tokenStatus??200});
    if(url===TESLA_EU_FLEET_API+'/api/1/partner_accounts')
      return Response.json({error:'SECRET_PROVIDER_BODY'},
        {status:overrides.registrationStatus??201,headers:{'x-txid':'tesla-trace-abcdef12'}});
    throw Error('Unexpected outbound URL');
  };
  return {state,storeFactory:()=>store,readPublic,fetcher};
}
test('registration blocked until distinct explicit authorization, independently of saved credentials',async()=>{
  const f=fixture();for(const [e,approved] of [
    [env,false],
    [{...env,TESLA_PARTNER_REGISTRATION_APPROVED:'false'},true],
    [{...env,VERCEL_ENV:'preview'},true],
    [{...env,APP_ORIGIN:'http://wrong.invalid'},true],
    [{...env,TESLA_FLEET_REGION:'na'},true]
  ])await assert.rejects(registerTeslaPartnerEUOnce({env:e,approved,...f}),/partner_registration_not_approved/);
  assert.equal(f.state.queries.length,0);
  assert.equal(f.state.reserved,0);
});
test('public PEM must match stored P-256 identity before any Tesla call or reservation',async()=>{
  const f=fixture({hostedPem:'not-the-public-key'});
  await assert.rejects(registerTeslaPartnerEUOnce({env,approved:true,...f}),/partner_public_key_mismatch/);
  assert.equal(f.state.queries.length,1);
  assert.equal(f.state.reserved,0);
  assert.ok(f.state.queries.every(x=>!x.url.includes('fleet-')));
});
test('single authorized registration uses only token POST and Partner POST, never vehicle calls',async()=>{
  const f=fixture();
  const result=await registerTeslaPartnerEUOnce({env,approved:true,...f});
  assert.deepEqual(result,{registered:true,status:201,trace:'tesla-trace-abcdef12'});
  assert.equal(f.state.reserved,1);
  assert.equal(f.state.budgetSlots,2);
  assert.equal(f.state.read,1);
  assert.equal(f.state.queries.length,3);
  const [publicReq,tokenReq,partnerReq]=f.state.queries;
  assert.equal(publicReq.url,TESLA_P256_ORIGIN+TESLA_PUBLIC_KEY_PATH);
  assert.equal(publicReq.opt.method,'GET');
  assert.equal(tokenReq.url,TESLA_PARTNER_TOKEN_ENDPOINT);
  assert.equal(tokenReq.opt.method,'POST');
  const grant=new URLSearchParams(tokenReq.opt.body);
  assert.equal(grant.get('grant_type'),'client_credentials');
  assert.equal(grant.get('scope'),'openid vehicle_device_data');
  assert.equal(grant.get('client_id'),env.TESLA_CLIENT_ID);
  assert.equal(grant.get('client_secret'),env.TESLA_CLIENT_SECRET);
  assert.equal(partnerReq.url,TESLA_EU_FLEET_API+'/api/1/partner_accounts');
  assert.equal(partnerReq.opt.method,'POST');
  assert.equal(partnerReq.opt.headers['content-type'],'application/json');
  assert.equal(partnerReq.opt.headers.authorization,'Bearer FAKE_TOKEN_NEVER_LOG');
  assert.deepEqual(JSON.parse(partnerReq.opt.body),{domain:TESLA_APP_DOMAIN});
  assert.doesNotMatch(JSON.stringify(result),/FAKE_SECRET|FAKE_TOKEN|SECRET_PROVIDER_BODY/);
  assert.ok(f.state.queries.every(x=>!x.url.includes('/vehicles/')));
  await assert.rejects(registerTeslaPartnerEUOnce({env,approved:true,...f}),/partner_registration_already_reserved/);
  assert.equal(f.state.queries.length,4); // second attempt checks public URL only
  assert.equal(f.state.budgetSlots,2);
});
test('HTTP 403 preserves only diagnostic status and a safe request ID',async()=>{
  const f=fixture({registrationStatus:403});
  const result=await registerTeslaPartnerEUOnce({env,approved:true,...f});
  assert.deepEqual(result,{registered:false,status:403,trace:'tesla-trace-abcdef12'});
  assert.equal(f.state.queries.length,3);
  assert.equal(f.state.budgetSlots,2);
});
test('token error fails closed without registration POST; no unexpected fallback',async()=>{
  const f=fixture({tokenStatus:401});
  await assert.rejects(registerTeslaPartnerEUOnce({env,approved:true,...f}),/partner_registration_token_failed/);
  assert.equal(f.state.queries.length,2);
  assert.equal(f.state.budgetSlots,2);
  assert.equal(f.state.reserved,1);
});

test('recovery registration requires a stored Tesla not-found result and is itself one-shot',async()=>{
  const unverified=fixture({existingMarker:true});
  await assert.rejects(registerTeslaPartnerEUOnce({env,approved:true,recovery:true,...unverified}),
    /partner_registration_reservation_failed/);
  assert.equal(unverified.state.queries.length,1);

  const f=fixture({existingMarker:true,lookupStatus:'not_found'});
  const result=await registerTeslaPartnerEUOnce({env,approved:true,recovery:true,...f});
  assert.equal(result.registered,true);
  assert.equal(f.state.reserved,1);
  assert.equal(f.state.budgetSlots,2);
  assert.equal(f.state.queries.filter(x=>x.url===TESLA_EU_FLEET_API+'/api/1/partner_accounts').length,1);
  await assert.rejects(registerTeslaPartnerEUOnce({env,approved:true,recovery:true,...f}),
    /partner_registration_already_reserved/);
  assert.equal(f.state.queries.filter(x=>x.url===TESLA_EU_FLEET_API+'/api/1/partner_accounts').length,1);
});

test('legacy daily limit value does not block an authorized Production registration',async()=>{
  const f=fixture();
  const result=await registerTeslaPartnerEUOnce({
    env:{...env,TESLA_DAILY_READ_LIMIT:'1'},approved:true,...f
  });
  assert.equal(result.registered,true);
  assert.equal(f.state.queries.length,3);
  assert.equal(f.state.reserved,1);
  assert.equal(f.state.budgetSlots,2);
  assert.equal(await f.storeFactory().get('read-budget-extra:'+new Date().toISOString().slice(0,10)), '2');
});

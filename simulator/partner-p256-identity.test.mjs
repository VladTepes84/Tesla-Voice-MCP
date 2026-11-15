import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { unseal } from './lib/security.mjs';
import { persistentStore } from './lib/store.mjs';
import {
  TESLA_P256_IDENTITY_STORE_KEY, TESLA_P256_ORIGIN,
  readStoredTeslaP256Public, provisionTeslaP256Once
} from './lib/partner-p256-identity.mjs';
import { hostedTeslaPublicKeyFetch, TESLA_PUBLIC_KEY_PATH } from './api/tesla-public-key.mjs';

const secret = Buffer.alloc(32, 7).toString('base64');
const env = {
  APP_ORIGIN: TESLA_P256_ORIGIN,
  VERCEL_ENV: 'production',
  TESLA_FLEET_REGION: 'eu',
  TOKEN_ENCRYPTON_KEY_BASE64: secret,
  TOKEN_STORE_REST_URL: 'https://redis.invalid',
  TOKEN_STORE_REST_TOKEN: 'private-test-token'
};
const url = TESLA_P256_ORIGIN + TESLA_PUBLIC_KEY_PATH;
function memoryStore() {
  const items = new Map();
  let writes = 0;
  const store = {
    get: async key => items.get(key) ?? null,
    putOncePermanent: async (key, val) => {
      writes++;
      if (items.has(key)) return false;
      items.set(key, val);
      return true;
    }
  };
  return { items, store, writes: () => writes };
}

test('never provisions P-256 on Preview, wrong domain or missing encryption secret', async () => {
  let calls = 0;
  const storeFactory = () => { calls++; throw Error('forbidden'); };
  for (const bad of [
    { ...env, VERCEL_ENV: 'preview' },
    { ...env, VERCEL_ENV: 'development' },
    { ...env, APP_ORIGIN: 'http://wrong.invalid' },
    { ...env, TESLA_FLEET_REGION: 'na' },
    { ...env, TOKEN_ENCRYPTON_KEY_BASE64: '' }
  ]) {
    await assert.rejects(provisionTeslaP256Once({ env: bad, storeFactory }));
  }
  assert.equal(calls, 0);
});

test('refuses to generate over any pre-existing Tesla public key configured on Vercel', async () => {
  const mem=memoryStore();
  const old=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey
    .export({type:'spki',format:'pem'});
  const configured={...env,TESLA_PUBLIC_KEY_PEM_BASE64:Buffer.from(old).toString('base64')};
  await assert.rejects(provisionTeslaP256Once({env:configured,storeFactory:()=>mem.store}),
    /p256_existing_public_key_unverified/);
  assert.equal(mem.writes(),0);
});

test('creates only one P-256 identity and stores a non-expiring AES-GCM encrypted private PEM', async () => {
  const mem = memoryStore();
  const first = await provisionTeslaP256Once({env,storeFactory:()=>mem.store});
  assert.equal(first.created,true);
  assert.match(first.publicPem,/BEGIN PUBLIC KEY/);
  assert.match(first.sha256,/^[a-f0-9]{64}$/);
  assert.equal(mem.writes(),1);
  const ciphertext=mem.items.get(TESLA_P256_IDENTITY_STORE_KEY);
  // The public PEM is intentionally stored in clear; the private PEM never is.
  assert.doesNotMatch(ciphertext,/BEGIN (EC |)PRIVATE KEY/);
  assert.doesNotMatch(ciphertext,/private-test-token/);
  const record=JSON.parse(ciphertext);
  const clear=unseal(record.encryptedPrivate,Buffer.from(secret,'base64'),TESLA_P256_IDENTITY_STORE_KEY);
  assert.match(clear.pem,/BEGIN PRIVATE KEY/);
  assert.equal(createPublicKey(clear.pem).export({format:'pem',type:'spki'}),first.publicPem);
  const second=await provisionTeslaP256Once({env,storeFactory:()=>mem.store});
  assert.equal(second.created,false);
  assert.equal(second.sha256,first.sha256);
  assert.equal(mem.writes(),1);
  const pub=await readStoredTeslaP256Public({env,storeFactory:()=>mem.store});
  assert.deepEqual(pub,{publicPem:first.publicPem,sha256:first.sha256});
});

test('existing encrypted private key with wrong AES or tampered public cannot be silently rotated', async () => {
  const mem=memoryStore();
  await provisionTeslaP256Once({env,storeFactory:()=>mem.store});
  const other={...env,TOKEN_ENCRYPTON_KEY_BASE64:Buffer.alloc(32,8).toString('base64')};
  await assert.rejects(provisionTeslaP256Once({env:other,storeFactory:()=>mem.store}),/p256_identity_invalid/);
  const old=JSON.parse(mem.items.get(TESLA_P256_IDENTITY_STORE_KEY));
  old.publicPem=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'});
  mem.items.set(TESLA_P256_IDENTITY_STORE_KEY,JSON.stringify(old));
  await assert.rejects(provisionTeslaP256Once({env,storeFactory:()=>mem.store}),/p256_identity_invalid/);
  assert.equal(mem.writes(),1);
});

test('concurrent provisioning has one durable winner with a matching private-public pair', async () => {
  const mem=memoryStore();
  const [one,two]=await Promise.all([
    provisionTeslaP256Once({env,storeFactory:()=>mem.store}),
    provisionTeslaP256Once({env,storeFactory:()=>mem.store})
  ]);
  assert.equal(Number(one.created)+Number(two.created),1);
  assert.equal(one.publicPem,two.publicPem);
  assert.equal(mem.writes(),2);
});

test('Upstash REST uses atomic SET NX with no expiry for a permanent Tesla identity', async () => {
  const values=new Map(), commands=[];
  const fetcher=async (_,req)=>{
    assert.equal(req.headers.authorization,'Bearer private-test-token');
    const parts=JSON.parse(req.body);
    commands.push(parts);
    const [cmd,key,value,...rest]=parts;
    let answer=null;
    if(cmd==='GET')answer=values.get(key)??null;
    else if(cmd==='SET'){
      assert.deepEqual(rest,['NX']);
      if(!values.has(key)){values.set(key,value);answer='OK';}
    } else throw Error('Unrecognized Redis command');
    return Response.json({result:answer});
  };
  const store=persistentStore(env,fetcher);
  const result=await provisionTeslaP256Once({env,storeFactory:()=>store});
  assert.equal(result.created,true);
  assert.equal(commands.filter(x=>x[0]==='SET').length,1);
  assert.equal(commands.filter(x=>x[0]==='SET')[0][1],
    'tesla-voice:v1:'+TESLA_P256_IDENTITY_STORE_KEY);
  assert.doesNotMatch(JSON.stringify(commands.filter(x=>x[0]==='SET').map(x=>x.slice(0,2))),/EX/);
});

test('public URL serves only matching P-256 PEM and does not expose AES key or encrypted record',async()=>{
  const mem=memoryStore();
  const result=await provisionTeslaP256Once({env,storeFactory:()=>mem.store});
  let reads=0;
  const readPublic=async()=>{reads++;return readStoredTeslaP256Public({env,storeFactory:()=>mem.store});};
  const ok=await hostedTeslaPublicKeyFetch(new Request(url),{env,readPublic});
  assert.equal(ok.status,200);
  assert.equal(await ok.text(),result.publicPem);
  assert.equal(ok.headers.get('content-type'),'text/plain; charset=utf-8');
  for(const request of [
    new Request(url+'?token=secret'),
    new Request(url,{method:'POST'}),
    new Request('https://wrong.vercel.app'+TESLA_PUBLIC_KEY_PATH)
  ]){
    const r=await hostedTeslaPublicKeyFetch(request,{env,readPublic});
    assert.ok([404,405].includes(r.status));
    assert.doesNotMatch(await r.text(),/BEGIN PUBLIC|PRIVATE|secret|token/);
  }
  assert.equal(reads,1);
  const preview=await hostedTeslaPublicKeyFetch(new Request(url),{
    env:{...env,VERCEL_ENV:'preview'},readPublic
  });
  assert.equal(preview.status,404);
  assert.equal(reads,1);
});

test('a different operator HTTPS origin can provision and serve its own public key', async () => {
  const customEnv={...env,APP_ORIGIN:'https://another.example.invalid'};
  const mem=memoryStore();
  const identity=await provisionTeslaP256Once({env:customEnv,storeFactory:()=>mem.store});
  assert.equal(identity.created,true);
  const response=await hostedTeslaPublicKeyFetch(new Request(customEnv.APP_ORIGIN+TESLA_PUBLIC_KEY_PATH),{
    env:customEnv,readPublic:async()=>identity
  });
  assert.equal(response.status,200);
  const wrong=await hostedTeslaPublicKeyFetch(new Request('https://different.example.invalid'+TESLA_PUBLIC_KEY_PATH),{
    env:customEnv,readPublic:async()=>assert.fail('must not read keys for another origin')
  });
  assert.equal(wrong.status,404);
});

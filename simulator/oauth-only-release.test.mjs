import test from 'node:test';
import assert from 'node:assert/strict';
import { route, runtime } from './lib/runtime.mjs';

const origin = 'https://mcp.example.invalid';
const env = {
  VERCEL_ENV: 'production',
  APP_ORIGIN: origin,
  MCP_AUTH_ISSUER: 'https://issuer.example.invalid/',
  TESLA_REAL_RELEASE_APPROVED: 'true',
  TESLA_BACKEND_ENABLED: 'true',
  TESLA_READ_ENABLED: 'true', // test accidental flag; code must still BLOCK reads
  TESLA_FLEET_REGION: 'eu',
  TESLA_CLIENT_ID: 'fixture-client',
  TESLA_CLIENT_SECRET: 'fixture-secret',
  MCP_AUTH_JWKS: JSON.stringify({ keys: [{ kty:'RSA', kid:'fixture-public' }] }),
  MCP_ALLOWED_SUBJECT: 'fixture-owner',
  TOKEN_ENCRYPTON_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  TOKEN_STORE_REST_URL: 'https://redis.invalid',
  TOKEN_STORE_REST_TOKEN: 'fixture-redis-secret',
  TESLA_VEHICLE_VIN: '5YJ3E1EA0LF000000',
  TESLA_DAILY_READ_LIMIT: '10'
};

test('Owner-authorized Production enables only the explicitly gated live read path',async()=>{
  const { config, backend }=runtime(env);
  assert.equal(config.origin,origin);
  assert.equal(config.issuer,'https://issuer.example.invalid/');
  assert.equal(config.env.TESLA_READ_ENABLED,'true');
  assert.equal(typeof backend.battery,'function');
  assert.equal(typeof backend.prepareConnect,'function');
  assert.equal(runtime({...env,TESLA_READ_ENABLED:'false'}).config.env.TESLA_READ_ENABLED,'false');
});
test('OAuth backend refuses Preview, missing release consent and missing backend flag',()=>{
  for(const cfg of [
    {...env,VERCEL_ENV:'preview'},
    {...env,VERCEL_ENV:'development'},
    {...env,TESLA_REAL_RELEASE_APPROVED:'false'},
    {...env,TESLA_REAL_RELEASE_APPROVED:''},
    {...env,TESLA_BACKEND_ENABLED:'false'}
  ]) assert.throws(()=>runtime(cfg));
});
test('OAuth-start requires POST and authenticated JWT without contacting Tesla',async()=>{
  const old={...process.env};
  try {
    for(const key of Object.keys(process.env)) if(key.startsWith('TESLA_')||
      key.startsWith('TOKEN_')||key.startsWith('MCP_')||key==='APP_ORIGIN'||key==='VERCEL_ENV')
      delete process.env[key];
    Object.assign(process.env,env);
    const start=route('start');
    const request=new Request(origin+'/oauth/tesla/start',{method:'GET'});
    const r=await start(request);
    assert.equal(r.status,405);
    const denied=await start(new Request(origin+'/oauth/tesla/start',{
      method:'POST',headers:{origin,'content-type':'application/json'},
      body:'{}'
    }));
    assert.equal(denied.status,401);
    const callback=route('callback');
    const invalid=await callback(new Request(origin+'/oauth/tesla/callback?invalid=SECRET'));
    assert.equal(invalid.status,400);
    assert.doesNotMatch(await invalid.text(),/SECRET|fixture-client|fixture-owner/);
  }finally{
    for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];
    Object.assign(process.env,old);
  }
});

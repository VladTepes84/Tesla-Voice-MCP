import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { configuration } from './lib/security.mjs';
import { createTeslaBackend } from './lib/tesla.mjs';
import { realMcp } from './lib/real-mcp.mjs';
import { request as mcpRequest } from './offline-request.mjs';
import { readFileSync } from 'node:fs';

const origin='https://example.invalid';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keys.publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const config=configuration({
  APP_ORIGIN:origin,MCP_AUTH_ISSUER:'https://issuer.invalid/',
  MCP_AUTH_JWKS:JSON.stringify({keys:[jwk]}),
  MCP_ALLOWED_SUBJECT:'owner',
  TOKEN_ENCRYPTON_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),
  TESLA_CLIENT_ID:'fake-client',TESLA_CLIENT_SECRET:'fake-secret',
  TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'false',
  TESLA_DAILY_READ_LIMIT:'10'
});
function memory() {
  const records=new Map();let time=Date.now();
  const get=key=>{
    const v=records.get(key);
    if(!v || v.exp<=time){records.delete(key);return null;}return v.val;
  };
  const put=async(key,val,ttl)=>records.set(key,{val,exp:time+ttl*1000});
  const once=async(key,ttl)=>{if(get(key)!==null)return false;await put(key,'1',ttl);return true;};
  const take=async key=>{const val=get(key);records.delete(key);return val;};
  const lock=async key=>({save:async(value,ttl)=>put(key,value,ttl),release:async()=>{}});
  return {store:{get,put,once,take,lock},advance:ms=>{time+=ms;},now:()=>time};
}
function fixture(){
  const m=memory(),calls=[];
  const backend=createTeslaBackend({config,store:m.store,now:m.now,fetcher:async(url,opts)=>{
    calls.push({url,opts});
    if(!url.includes('/token'))throw Error('Vehicle/network access forbidden');
    return Response.json({
      access_token:'mock-access',refresh_token:'mock-refresh',
      token_type:'Bearer',scope:'openid offline_access vehicle_device_data',expires_in:3600
    });
  }});
  return {...m,backend,calls};
}
function jwt(scope='tesla:connect'){
  const ts=Math.floor(Date.now()/1000);
  const hdr=Buffer.from(JSON.stringify({alg:'RS256',typ:'at+jwt',kid:'test-key'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:config.issuer,aud:config.audience,sub:'owner',scope,iat:ts,exp:ts+600})).toString('base64url');
  return hdr+'.'+payload+'.'+sign('RSA-SHA256',Buffer.from(hdr+'.'+payload),keys.privateKey).toString('base64url');
}
function rpc(method,params,scope='tesla:connect'){
  const base=mcpRequest(method,params),headers=new Headers(base.headers);
  headers.set('authorization','Bearer '+jwt(scope));
  return new Request(config.audience,{method:'POST',headers,body:base.body,duplex:'half'});
}
function confirmLink(link, requestOrigin=origin) {
  const ticket = new URL(link).searchParams.get('ticket');
  return new Request(origin+'/oauth/tesla/launch', { method:'POST', headers:{origin:requestOrigin,'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ticket}) });
}
test('Single-use link starts browser-bound Tesla OAuth with S256 and safely completes mock callback',async()=>{
  const f=fixture();
  const link=await f.backend.prepareConnect('owner');
  assert.equal(link.source,'TESLA_OAUTH_LINK');
  assert.equal(link.expires_in_seconds,300);
  assert.equal(new URL(link.connect_url).origin,origin);
  assert.equal(f.calls.length,0);
  assert.doesNotMatch(JSON.stringify(link),/mock-refresh|fake-secret|BEGIN PRIVATE KEY/);
  const request=new Request(link.connect_url);
  const firstView=await f.backend.launch(request);
  assert.equal(firstView.status,200);
  assert.equal(firstView.headers.get('referrer-policy'),'origin');
  assert.match(firstView.headers.get('content-security-policy'), /form-action 'self' https:\/\/auth\.tesla\.com;/);
  assert.match(await firstView.text(),/Continue with Tesla/);
  assert.equal((await f.backend.launch(request)).status,200); // previews cannot consume the ticket
  assert.equal((await f.backend.launch(confirmLink(link.connect_url,'https://other.invalid'))).status,403);
  const launched=await f.backend.launch(confirmLink(link.connect_url));
  assert.equal(launched.status,303);
  assert.equal(launched.headers.get('referrer-policy'),'no-referrer');
  assert.match(launched.headers.get('set-cookie'),/__Host-tesla-oauth=.*Secure; HttpOnly; SameSite=Lax/);
  const tesla=new URL(launched.headers.get('location'));
  assert.equal(tesla.origin,'https://auth.tesla.com');
  assert.equal(tesla.searchParams.get('code_challenge_method'),'S256');
  assert.equal(tesla.searchParams.get('redirect_uri'),config.callback);
  assert.deepEqual(tesla.searchParams.get('scope').split(' '),['openid','offline_access','vehicle_device_data','vehicle_location','vehicle_cmds','vehicle_charging_cmds']);
  assert.equal(f.calls.length,0); // Nothing is sent to Tesla until user consents in browser
  const replay=await f.backend.launch(confirmLink(link.connect_url));
  assert.equal(replay.status,410);
  const cookie=launched.headers.get('set-cookie').split(';')[0];
  const state=tesla.searchParams.get('state');
  const cb=await f.backend.callback(new Request(config.callback+'?state='+state+'&code=mock-code',{
    headers:{cookie}
  }));
  assert.equal(cb.status,200);
  assert.match(await cb.text(),/Tesla connected/);
  assert.equal(f.calls.length,1); // OAuth token POST, no vehicle read
  const alreadyConnected=await f.backend.prepareConnect('owner');
  assert.equal(alreadyConnected.source,'EXISTING_TESLA_CONNECTION');
  assert.equal(alreadyConnected.connected,true);
  assert.equal(alreadyConnected.connect_url,undefined);
  assert.equal(f.calls.length,1); // Repeated connect requests never contact Tesla.
  await assert.rejects(f.backend.battery('owner'),/disabled/);
  assert.equal(f.calls.length,1);
});
test('Browser ticket rejects invalid, foreign, repeated and expired requests without any Tesla calls',async()=>{
  const f=fixture();
  for(const url of [
    origin+'/oauth/tesla/launch',
    origin+'/oauth/tesla/launch?ticket=short',
    origin+'/oauth/tesla/launch?ticket='+('a'.repeat(43))+'&ticket=x',
    origin+'/oauth/tesla/launch?ticket='+('a'.repeat(43))+'&evil=x',
    origin+'/oauth/tesla/launch?ticket='+('a'.repeat(43))+'&utm_source=other',
    origin+'/oauth/tesla/launch?ticket='+('a'.repeat(43))+'&utm_source=chatgpt.com&utm_source=chatgpt.com'
  ])assert.equal((await f.backend.launch(new Request(url))).status,400);
  const foreign=await f.backend.prepareConnect('owner');
  assert.equal((await f.backend.launch(new Request(foreign.connect_url.replace(origin,'https://other.invalid')))).status,400);
  f.advance(301000);
  assert.equal((await f.backend.launch(new Request(foreign.connect_url))).status,410);
  assert.equal(f.calls.length,0);
});
test('ChatGPT attribution preserves one-use handoff without making Tesla requests',async()=>{
  const f=fixture();
  const link=await f.backend.prepareConnect('owner');
  const url=new URL(link.connect_url);
  url.searchParams.set('utm_source','chatgpt.com');
  const request=new Request(url);
  assert.equal((await f.backend.launch(request)).status,200);
  assert.equal((await f.backend.launch(request)).status,200);
  const launched=await f.backend.launch(confirmLink(url));
  assert.equal(launched.status,303);
  assert.equal(new URL(launched.headers.get('location')).origin,'https://auth.tesla.com');
  assert.equal((await f.backend.launch(confirmLink(url))).status,410);
  assert.equal(f.calls.length,0);
});
test('handoff form rejects duplicate fields, extra fields and foreign origins',async()=>{
  const f=fixture(), link=await f.backend.prepareConnect('owner');
  const ticket=new URL(link.connect_url).searchParams.get('ticket');
  const post=(body,originHeader=origin)=>new Request(origin+'/oauth/tesla/launch',{
    method:'POST',headers:{origin:originHeader,'content-type':'application/x-www-form-urlencoded'},body
  });
  assert.equal((await f.backend.launch(post('ticket='+ticket+'&ticket='+ticket))).status,400);
  assert.equal((await f.backend.launch(post('ticket='+ticket+'&extra=x'))).status,400);
  assert.equal((await f.backend.launch(post('ticket='+ticket+'&extra='+('x'.repeat(1024))))).status,400);
  assert.equal((await f.backend.launch(post('ticket='+ticket,'https://other.invalid'))).status,403);
  assert.equal((await f.backend.launch(post('ticket='+ticket,'null'))).status,403);
  assert.equal((await f.backend.launch(confirmLink(link.connect_url))).status,303);
  assert.equal(f.calls.length,0);
});
test('MCP grants link only for tesla:connect scope and never authorizes a battery read with that token',async()=>{
  const f=fixture(),run=realMcp({config,backend:f.backend});
  const tools=await (await run(rpc('tools/list',{}))).json();
  assert.deepEqual(tools.result.tools.map(x=>x.name),['connect_tesla','prepare_vehicle_command_setup']);
  const link=await (await run(rpc('tools/call',{name:'connect_tesla',arguments:{}}))).json();
  const result=JSON.parse(link.result.content[0].text);
  assert.equal(result.source,'TESLA_OAUTH_LINK');
  assert.match(result.connect_url,/oauth\/tesla\/launch\?ticket=/);
  const noRead=await run(rpc('tools/call',{name:'get_battery',arguments:{}}));
  assert.equal(noRead.status,200);
  assert.equal((await noRead.json()).error.code,-32602);
  assert.equal(f.calls.length,0);
  const batteryOnly=await run(rpc('tools/call',{name:'connect_tesla',arguments:{}},'battery:read'));
  assert.equal(batteryOnly.status,401);
  assert.equal(f.calls.length,0);
});
test('existing project routes browser handoff without adding a separate web app',()=>{
  const v=JSON.parse(readFileSync(new URL('./vercel.json',import.meta.url),'utf8'));
  assert.deepEqual(v.routes.filter(x=>x.src==='/oauth/tesla/launch'),[
    {src:'/oauth/tesla/launch',dest:'/api/oauth/tesla/launch'}
  ]);
  assert.equal(v.functions['api/oauth/tesla/launch.mjs'].maxDuration,30);
  assert.equal(v.routes.at(-1).status,404);
});

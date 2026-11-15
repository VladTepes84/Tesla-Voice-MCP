import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from './lib/security.mjs';
import protectedResource from './api/protected-resource.mjs';

const ORIGIN='https://mcp.example.invalid';
const ISSUER='https://issuer.example.invalid/';
const fixture={
  APP_ORIGIN:ORIGIN,
  MCP_AUTH_JWKS:JSON.stringify({keys:[{kty:'RSA',kid:'public-fixture'}]}),
  MCP_ALLOWED_SUBJECT:'fixture-subject',
  TOKEN_ENCRYPTON_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),
  TESLA_CLIENT_ID:'fixture-client',
  TESLA_CLIENT_SECRET:'fixture-secret',
  TESLA_FLEET_REGION:'eu',
  TESLA_BACKEND_ENABLED:'true'
};
test('Production configuration requires an explicitly configured issuer',()=>{
  assert.throws(()=>configuration(fixture));
  const config=configuration({...fixture,MCP_AUTH_ISSUER:ISSUER});
  assert.equal(config.issuer,ISSUER);
  assert.equal(config.audience,ORIGIN+'/mcp');
  assert.equal(config.env.MCP_ALLOWED_SUBJECT,'fixture-subject');
  assert.equal(config.key.length,32);
});
test('explicit issuer remains validated; malformed HTTP issuers rejected',()=>{
  assert.equal(configuration({...fixture,MCP_AUTH_ISSUER:ISSUER}).issuer,ISSUER);
  assert.throws(()=>configuration({...fixture,MCP_AUTH_ISSUER:'http://not-authenticated.invalid/'}),/configuration/);
});
test('Production OAuth resource metadata fails closed if issuer is absent',async()=>{
  const names=['APP_ORIGIN','MCP_AUTH_ISSUER','VERCEL_ENV','TESLA_READ_ENABLED','TESLA_LOCATION_ENABLED','TESLA_COMMANDS_ENABLED','TESLA_COMMAND_EXECUTION_ENABLED'];
  const prior=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  try{
    process.env.APP_ORIGIN=ORIGIN;
    process.env.VERCEL_ENV='production';
    delete process.env.MCP_AUTH_ISSUER;
    for(const name of names.slice(2)) delete process.env[name];
    const r=protectedResource.fetch(new Request(ORIGIN+'/.well-known/oauth-protected-resource'));
    assert.equal(r.status,503);
  }finally{
    for(const [key,val] of Object.entries(prior)){
      if(val===undefined)delete process.env[key];else process.env[key]=val;
    }
  }
});
test('Production resource metadata publishes each added MCP scope exactly once and only behind its gates',async()=>{
  const names=['APP_ORIGIN','MCP_AUTH_ISSUER','VERCEL_ENV','TESLA_READ_ENABLED','TESLA_LOCATION_ENABLED','TESLA_COMMANDS_ENABLED','TESLA_COMMAND_EXECUTION_ENABLED'];
  const prior=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  try{
    process.env.APP_ORIGIN=ORIGIN;
    process.env.MCP_AUTH_ISSUER=ISSUER;
    process.env.VERCEL_ENV='production';
    process.env.TESLA_READ_ENABLED='true';
    process.env.TESLA_LOCATION_ENABLED='true';
    process.env.TESLA_COMMANDS_ENABLED='true';
    process.env.TESLA_COMMAND_EXECUTION_ENABLED='false';
    let r=protectedResource.fetch(new Request(ORIGIN+'/.well-known/oauth-protected-resource'));
    assert.deepEqual((await r.json()).scopes_supported,['tesla:connect','battery:read','location:read']);
    process.env.TESLA_COMMAND_EXECUTION_ENABLED='true';
    r=protectedResource.fetch(new Request(ORIGIN+'/.well-known/oauth-protected-resource'));
    const scopes=(await r.json()).scopes_supported;
    assert.deepEqual(scopes,['tesla:connect','battery:read','location:read','vehicle:control']);
    assert.equal(new Set(scopes).size,scopes.length);
  }finally{
    for(const [key,val] of Object.entries(prior)){if(val===undefined)delete process.env[key];else process.env[key]=val;}
  }
});
test('Preview discovery advertises battery and map scopes without vehicle control',async()=>{
  const names=['APP_ORIGIN','MCP_AUTH_ISSUER','VERCEL_ENV','TESLA_READ_ENABLED','TESLA_LOCATION_ENABLED','TESLA_COMMANDS_ENABLED','TESLA_COMMAND_EXECUTION_ENABLED'];
  const prior=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  try{
    process.env.MCP_AUTH_ISSUER=ISSUER;
    process.env.APP_ORIGIN='https://preview.example.invalid';
    process.env.VERCEL_ENV='preview';
    process.env.TESLA_READ_ENABLED='true';
    process.env.TESLA_LOCATION_ENABLED='true';
    process.env.TESLA_COMMANDS_ENABLED='true';
    process.env.TESLA_COMMAND_EXECUTION_ENABLED='true';
    const r=protectedResource.fetch(new Request('https://preview.example.invalid/.well-known/oauth-protected-resource'));
    assert.equal(r.status,200);
    const data=await r.json();
    assert.equal(data.resource,'https://preview.example.invalid/mcp');
    assert.deepEqual(data.scopes_supported,['battery:read','location:read']);
  }finally{
    for(const [key,val] of Object.entries(prior)){if(val===undefined)delete process.env[key];else process.env[key]=val;}
  }
});

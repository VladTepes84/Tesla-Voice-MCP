import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {realMcp} from './lib/real-mcp.mjs';import {request} from './offline-request.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'offline-auth-fixture',use:'sig',alg:'RS256'};
const config={origin:'https://example.invalid',issuer:'https://issuer.invalid/',audience:'https://example.invalid/mcp',jwks:{keys:[jwk]},env:{MCP_ALLOWED_SUBJECT:'offline-user',TESLA_READ_ENABLED:'true'}};
const jwt=patch=>{
 const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url');
 const p=Buffer.from(JSON.stringify({iss:config.issuer,aud:config.audience,sub:'offline-user',iat:now-10,exp:now+600,scope:'battery:read',...patch})).toString('base64url');
 return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');
};
const args={energyToBatteryKwh:10,efficiencyPercent:100,first:{label:'a',eurPerKwh:0.2,fixedFeeEur:0},second:{label:'b',eurPerKwh:0.3,fixedFeeEur:0}};
const handler=()=>realMcp({config,backend:new Proxy({},{get(){assert.fail('vehicle backend accessed');}})});
const req=token=>request('tools/call',{name:'compare_charging_costs',arguments:args},token?{authorization:'Bearer '+token}:{});
test('MCP expired token returns resource challenge without server-side refresh or vehicle access',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('unexpected network');};
 try{
 const now=Math.floor(Date.now()/1000),r=await handler()(req(jwt({iat:now-100,exp:now-1})));
 assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/resource_metadata=.*oauth-protected-resource/);assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});
test('MCP resource audience and issuer mismatch fail closed',async()=>{
 for(const patch of [{aud:'https://wrong.invalid/mcp'},{iss:'https://wrong.invalid/'}])assert.equal((await handler()(req(jwt(patch)))).status,401);
});
test('valid MCP battery scope permits pure calculation without vehicle backend',async()=>{
 const r=await handler()(req(jwt({aud:[config.audience,'other']})));assert.equal(r.status,200);
 const body=await r.json();assert.equal(JSON.parse(body.result.content[0].text).first.estimated_eur,2);
});
test('connection scope alone requires per-tool battery authorization instead of reading vehicle',async()=>{
 const r=await handler()(req(jwt({scope:'tesla:connect'})));const body=await r.json();
 assert.equal(r.status,200);assert.equal(body.result.isError,true);
 assert.equal(JSON.parse(body.result.content[0].text).error.required_scope,'battery:read');
});
test('missing bearer and unrelated scopes remain unauthorized',async()=>{
 assert.equal((await handler()(req())).status,401);
 assert.equal((await handler()(req(jwt({scope:'offline_access'})))).status,401);
});

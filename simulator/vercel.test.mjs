import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from './api/mcp.mjs';
import { handleTeslaCallback } from './api/oauth/tesla/callback.mjs';
import { request } from './offline-request.mjs';
import { readFile } from 'node:fs/promises';

test('Vercel adapter fails closed for unsupported modes, independent of environment', async()=> {
 for(const mode of ['', 'true','tesla','private']) {
   assert.equal((await createHandler(mode)(request('tools/list'))).status,503);
 }
});
test('Vercel adapter defaults to explicitly configured simulation mode only', async()=> {
 const status = (await createHandler()(request('tools/list'))).status;
 assert.equal(status, process.env.SIMULATED_MCP_MODE === 'public-simulated' ? 200 : 503);
});
test('enabled adapter exposes only invented data over HTTPS POST /mcp',async()=> {
 const run=createHandler('public-simulated');
 const r=await run(request('tools/call',{name:'get_simulated_battery',arguments:{}}));
 const data=JSON.parse((await r.json()).result.content[0].text);
 assert.equal(data.source,'SIMULATED');assert.equal(data.battery_percent,70);
 assert.equal((await run(new Request('https://example.invalid/api/mcp'))).status,404);
 assert.equal((await run(new Request('https://example.invalid/mcp'))).status,405);
 assert.equal((await run(new Request('http://example.invalid/mcp',{method:'POST'}))).status,400);
});
test('Tesla callback fails closed without backend configuration and never reflects secrets',async()=> {
 const real=await handleTeslaCallback(new Request('https://example.invalid/oauth/tesla/callback?code=SECRET&state=PRIVATE'));
 // Authorized Production rejects wrong origin (404); disabled environments return 503.
 assert.ok([404,503].includes(real.status));
 assert.equal(real.headers.get('cache-control'),'no-store');
 assert.equal(real.headers.get('referrer-policy'),'no-referrer');
 assert.doesNotMatch(await real.text(),/SECRET|PRIVATE/);
});
test('configuration routes protected backend without frontend or Git auto deploy',async()=> {
 const c=JSON.parse(await readFile(new URL('./vercel.json',import.meta.url)));
 assert.equal(c.github.enabled,false);
 for (const path of ['/mcp','/oauth/tesla/start','/oauth/tesla/callback','/oauth/tesla/partner-registration','/oauth/tesla/partner-key-check','/.well-known/oauth-protected-resource','/.well-known/appspecific/com.tesla.3p.public-key.pem']) assert.ok(c.routes.some(r=>r.src===path && r.dest.startsWith('/api/')));
 assert.equal(c.functions['api/oauth/tesla/partner-registration.mjs'].maxDuration,30);
 assert.equal(c.functions['api/oauth/tesla/partner-key-check.mjs'].maxDuration,30);
 assert.equal(c.routes.at(-1).status,404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createWorker } from './worker.mjs';
import { request } from './offline-request.mjs';
async function rpc(method, params) { return (await worker.fetch(request(method, params))).json(); }
test('discovery has server identity, supported version and capabilities', async () => {
 const r = await rpc('server/discover'); assert.equal(r.result._meta['io.modelcontextprotocol/serverInfo'].name, 'tesla-voice-simulated'); assert.deepEqual(r.result.supportedVersions, ['2026-07-28']); assert.deepEqual(r.result.capabilities, { tools: {} }); assert.equal(r.result.ttlMs, 0); assert.equal(r.result.cacheScope, 'private'); assert.equal(r.result.resultType, 'complete'); assert.equal(r.result._meta['io.modelcontextprotocol/serverInfo'].name, 'tesla-voice-simulated');
});
test('tool list and simulated read; no outbound fetch', async () => {
 const original = globalThis.fetch; globalThis.fetch = () => { throw Error('outbound network'); };
 try {
 const listed=await rpc('tools/list'); assert.equal(listed.result.resultType, 'complete'); assert.equal(listed.result.ttlMs, 0); assert.equal(listed.result.cacheScope, 'private'); assert.equal(listed.result._meta['io.modelcontextprotocol/serverInfo'].name, 'tesla-voice-simulated'); assert.deepEqual(listed.result.tools.map(x=>x.name), ['get_simulated_battery']);
 const read = async () => JSON.parse((await rpc('tools/call', { name: 'get_simulated_battery', arguments: {} })).result.content[0].text);
 const called=await rpc('tools/call',{name:'get_simulated_battery',arguments:{}}); assert.equal(called.result.resultType,'complete'); assert.equal(called.result.isError,false); assert.equal(called.result._meta['io.modelcontextprotocol/serverInfo'].name, 'tesla-voice-simulated'); const a = await read(), b = await read(); assert.equal(a.source, 'SIMULATED'); assert.equal(a.battery_percent, 70); assert.notEqual(a.call_id, b.call_id);
 } finally { globalThis.fetch = original; }
});
test('passes modern and legacy MCP JSON-RPC ids into the tool invocation context', async () => {
 const seen=[];
 const local=createWorker({
  exposedTools:[{name:'mutating_test',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
  invokeTool:async(_name,_args,{requestId}={})=>{seen.push(requestId);return {accepted:true};}
 });
 const original=request('tools/call',{name:'mutating_test',arguments:{}});
 const body=await original.json();
 body.id='stable-call-id';
 const raw=JSON.stringify(body);
 const first=await local.fetch(new Request(original.url,{method:'POST',headers:original.headers,body:raw}));
 const second=await local.fetch(new Request(original.url,{method:'POST',headers:original.headers,body:raw}));
 const legacy=await local.fetch(new Request(original.url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'legacy-call-id',method:'tools/call',params:{name:'mutating_test',arguments:{}}})}));
 assert.equal(first.status,200);
 assert.equal(second.status,200);
 assert.equal(legacy.status,200);
 assert.deepEqual(seen,['stable-call-id','stable-call-id','legacy-call-id']);
});
test('commands and invalid arguments rejected', async () => {
 assert.equal((await rpc('tools/call', {name:'unlock_car'})).error.code,-32602);
 for (const args of [{vin:'x'},[],null,3]) {
 const r = await rpc('tools/call',{name:'get_simulated_battery',arguments:args});
 assert.equal(r.error.code,-32602);
 }
});
test('metadata header mismatches and missing metadata', async () => {
 for(const headers of [{'mcp-method':'wrong'},{'mcp-protocol-version':'wrong'}]) assert.equal((await (await worker.fetch(request('tools/list',{},headers))).json()).error.code,-32020);
 assert.equal((await (await worker.fetch(request('tools/call',{name:'get_simulated_battery'},{'mcp-name':'wrong'}))).json()).error.code,-32020);
});
test('encoded tool name accepted', async()=> {
 const r = await worker.fetch(request('tools/call',{name:'get_simulated_battery'},{'mcp-name':'=?base64?'+btoa('get_simulated_battery')+'?='})); assert.ok((await r.json()).result);
});
test('unsupported version returns supported versions',async()=> {
 const req=request('tools/list'); const b=await req.json(); b.params._meta['io.modelcontextprotocol/protocolVersion']='1900-01-01';
 const r=await worker.fetch(new Request(req.url,{method:'POST',headers:{...Object.fromEntries(req.headers),'mcp-protocol-version':'1900-01-01'},body:JSON.stringify(b)})); assert.equal(r.status,400); assert.equal((await r.json()).error.code,-32022);
});
test('HTTP methods, Origin, media and accept checked',async()=> {
 assert.equal((await worker.fetch(new Request('https://example.invalid/mcp'))).status,405);
 assert.equal((await worker.fetch(request('tools/list',{}, {origin:'https://evil.invalid'}))).status,403);
 assert.equal((await worker.fetch(request('tools/list',{}, {'content-type':'text/plain'}))).status,415);
 assert.equal((await worker.fetch(request('tools/list',{}, {accept:'application/json'}))).status,406);
});
test('legacy initialize and unknown methods explicitly rejected',async()=> {
 for(const method of ['initialize','unknown']) {const r=await worker.fetch(request(method)); assert.equal(r.status,404);assert.equal((await r.json()).error.code,-32601);}
});
test('malformed JSON, batch and oversized streaming body rejected',async()=> {
 const headers=Object.fromEntries(request('tools/list').headers);
 for(const [body,code] of [['{',-32700],['[]',-32600]]) assert.equal((await (await worker.fetch(new Request('https://example.invalid/mcp',{method:'POST',headers,body}))).json()).error.code,code);
 assert.equal((await worker.fetch(new Request('https://example.invalid/mcp',{method:'POST',headers,body:'x'.repeat(4097)}))).status,413);
});

test('clientInfo is optional in 2026-era request while clientCapabilities is required', async () => {
 const original=request('server/discover');
 const body=await original.json();
 delete body.params._meta['io.modelcontextprotocol/clientInfo'];
 const r=await worker.fetch(new Request(original.url,{method:'POST',headers:original.headers,body:JSON.stringify(body)}));
 assert.equal(r.status,200);
 assert.equal((await r.json()).result.resultType,'complete');
 delete body.params._meta['io.modelcontextprotocol/clientCapabilities'];
 const rejected=await worker.fetch(new Request(original.url,{method:'POST',headers:original.headers,body:JSON.stringify(body)}));
 assert.equal(rejected.status,400);
 assert.equal((await rejected.json()).error.code,-32602);
});

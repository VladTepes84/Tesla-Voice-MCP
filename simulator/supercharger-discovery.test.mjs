import test from 'node:test';
import assert from 'node:assert/strict';
import {realMcp} from './lib/real-mcp.mjs';
import {statusFixture} from './test-support/mcp-status-fixture.mjs';
import {request} from './offline-request.mjs';

// Authenticated dispatcher with generated JWT and stub backend. No real Tesla,
// token refresh, Redis or command dispatch. This is not Production acceptance.
function fixture(){
 let handler,authorization,io=0;
 const calls=[];
 const f=statusFixture({fetcher:()=>{io++;throw Error('Unexpected storage/network');}},{
  createTeslaBackend:()=>({
   executeRequestedCommand:async(...args)=>{calls.push(args);return {status:'fixture_only_no_dispatch'};},
   prepareCommand:async()=>{throw Error('Unexpected preparation');},
   vehicleCommandStatus:async()=>({state:'not_found',retry_allowed:false})
  }),
  realMcp:options=>{handler=realMcp(options);return req=>{authorization=req.headers.get('authorization');return handler(req);};}
 });
 return {f,calls,io:()=>io,async list(legacy){
  await f.rpc({}, {name:'get_vehicle_command_catalog',scope:'battery:read'});
  const req=legacy?new Request(f.config.audience,{method:'POST',headers:{authorization,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'list',method:'tools/list'})}):request('tools/list',{}, {authorization},f.config.audience);
  const response=await handler(req);assert.equal(response.status,200);return (await response.json()).result.tools;
 }};
}
for(const legacy of [false,true])test(`Supercharger execution discovery excludes unsupported transport, keeps history and single navigation (${legacy?'legacy':'modern'})`,async()=>{
 const x=fixture(),tools=await x.list(legacy);
 for(const name of ['prepare_vehicle_command','execute_requested_vehicle_command']){
  const operations=tools.find(t=>t.name===name).inputSchema.properties.operation.enum;
  assert.equal(operations.includes('navigation_sc_request'),name==='prepare_vehicle_command');
  assert.ok(operations.includes('navigation_request'));
 }
 assert.ok(tools.find(t=>t.name==='get_vehicle_command_status').inputSchema.properties.operation.enum.includes('navigation_sc_request'));
 const prepared=await x.f.rpc({operation:'navigation_sc_request',arguments:{id:9994}},{legacy,name:'prepare_vehicle_command'});
 assert.equal(prepared.result.status,'payload_prepared_not_executable');
 assert.deepEqual(prepared.result.payload,{id:9994});
 assert.equal(prepared.result.dispatch_performed,false);
 assert.equal(prepared.result.ticket,undefined);
 assert.equal(x.calls.length,0);assert.equal(x.io(),0);assert.equal(x.f.teslaCalls(),0);
 const denied=await x.f.rpc({operation:'navigation_sc_request',arguments:{}},{legacy,name:'execute_requested_vehicle_command'});
 assert.equal(denied.body.error.code,-32602);
 assert.equal(x.calls.length,0);
 // No implicit substitution, auto-retry, Tesla contact or quota reservation.
 assert.equal(x.io(),0);assert.equal(x.f.teslaCalls(),0);
 const catalog=(await x.f.rpc({}, {legacy,name:'get_vehicle_command_catalog',scope:'battery:read'})).result;
 assert.equal(catalog.operations.find(o=>o.operation==='navigation_sc_request').transport_supported,false);
 assert.equal(catalog.operations.find(o=>o.operation==='navigation_sc_request').single_destination_alternative.operation,'navigation_request');
 const destination='Tesla Supercharger Westville, indirizzo selezionato fixture';
 const accepted=await x.f.rpc({operation:'navigation_request',arguments:{destination}},{legacy,name:'execute_requested_vehicle_command'});
 assert.equal(accepted.result.status,'fixture_only_no_dispatch');
 assert.equal(x.calls.length,1);assert.equal(x.calls[0][1],'navigation_request');assert.deepEqual(x.calls[0][2],{destination});
 const status=await x.f.rpc({operation:'navigation_sc_request',arguments:{}},{legacy});
 assert.equal(status.result.state,'not_found');assert.equal(status.result.retry_allowed,false);
 assert.equal(x.calls.length,1);assert.equal(x.io(),0);
});

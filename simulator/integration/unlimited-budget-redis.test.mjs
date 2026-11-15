import test from 'node:test';
import assert from 'node:assert/strict';
import {localRedis} from '../test-support/redis-rest.mjs';
import {statusFixture} from '../test-support/mcp-status-fixture.mjs';
import {reserveTeslaRequests,readTeslaRequestBudget,consumeTeslaRequestReservation} from '../lib/request-budget.mjs';
import {hash,seal} from '../lib/security.mjs';
const now=()=>Date.UTC(2026,10,5,12),day='2026-11-05',env={VERCEL_ENV:'production',TESLA_DAILY_READ_LIMIT:'50'};
test('Production ignores the old 50 cap, meters requests atomically, preserves historical slots and preview can restore a cap',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db,{},env);
 for(let i=0;i<50;i++)await f.store.once(`read-budget:${day}:${i}`,172800);
 const results=await Promise.all(Array.from({length:80},()=>reserveTeslaRequests({store:f.store,env,now})));
 assert.equal(results.length,80);assert.equal(consumeTeslaRequestReservation(results[0],1),true);assert.equal(consumeTeslaRequestReservation(results[0],1),false);
 const budget=await readTeslaRequestBudget({store:f.store,env,now});assert.equal(budget.unlimited,true);assert.equal(budget.limit,null);assert.equal(budget.remaining,null);assert.equal(budget.reserved,130);
 assert.equal(await f.store.get('read-budget-extra:'+day),'80');assert.equal(await f.store.get(`read-budget:${day}:49`),'1');
 const capped={VERCEL_ENV:'preview',TESLA_DAILY_READ_LIMIT:'50'};assert.equal((await readTeslaRequestBudget({store:f.store,env:capped,now})).remaining,0);
 await assert.rejects(reserveTeslaRequests({store:f.store,env:capped,now}),/budget/);
 assert.equal((await readTeslaRequestBudget({store:f.store,env,now:()=>Date.UTC(2026,10,6,12)})).reserved,0);
 assert.equal(f.teslaCalls(),0);
});
test('unlimited never bypasses Redis failures, invalid counters or reservation validation',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db,{},env);
 await f.store.put('read-budget-extra:'+day,'corrupt',172800);
 await assert.rejects(reserveTeslaRequests({store:f.store,env,now}),/budget_store_unavailable/);
 assert.equal((await readTeslaRequestBudget({store:f.store,env,now})).available,false);
 await assert.rejects(reserveTeslaRequests({store:{get:async()=>null,once:async()=>true},env,now}),/budget_store_unavailable/);
 await assert.rejects(reserveTeslaRequests({store:f.store,env,now,count:101}),/configuration/);
 assert.equal(f.teslaCalls(),0);
});
test('authenticated MCP status reports unlimited as null, with readiness and zero Tesla requests',async t=>{
 const db=await localRedis();t.after(()=>db.close());const f=statusFixture(db,{},env),key='tokens:'+hash(f.config.issuer+'\nowner');
 await f.store.put(key,seal({access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,scopes:['vehicle_device_data']},f.config.key,key),86400);
 const reply=await f.rpc({}, {name:'get_connection_status',scope:'battery:read'});
 assert.equal(reply.response.status,200);assert.equal(reply.result.cached_read_readiness.budget.unlimited,true);assert.equal(reply.result.cached_read_readiness.budget.remaining,null);assert.equal(reply.result.cached_read_readiness.budget_sufficient,true);assert.equal(reply.result.cached_read_readiness.ready,true);assert.equal(f.teslaCalls(),0);
});

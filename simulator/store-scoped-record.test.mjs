import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentStore} from './lib/store.mjs';

test('a vehicle lease can persist and guard an action-scoped record',async()=>{
 const calls=[];
 const store=persistentStore({TOKEN_STORE_REST_URL:'https://redis.invalid',TOKEN_STORE_REST_TOKEN:'offline-test'},
  async (_url,options)=>{
   const args=JSON.parse(options.body);calls.push(args);
   return new Response(JSON.stringify({result:args[0]==='SET'?'OK':1}),{status:200,headers:{'content-type':'application/json'}});
  });
 const lock=await store.lock('vehicle-lock');
 assert.equal(await lock.saveWithGuard('record','vehicle:action-a:pending','owner',undefined,'vehicle:action-a'),true);
 await lock.savePermanent('updated-record',undefined,'vehicle:action-a');
 await lock.release();
 const claim=calls.find(args=>args[0]==='EVAL'&&String(args[1]).includes('command_guard_claim'));
 const save=calls.find(args=>args[0]==='EVAL'&&String(args[1]).includes("redis.call('SET',KEYS[2],ARGV[2]); return 1"));
 assert.ok(claim);
 assert.ok(save);
 assert.equal(claim[3],'tesla-voice:v1:lock:vehicle-lock');
 assert.equal(claim[4],'tesla-voice:v1:vehicle:action-a');
 assert.equal(claim[5],'tesla-voice:v1:vehicle:action-a:pending');
 assert.equal(save[3],'tesla-voice:v1:lock:vehicle-lock');
 assert.equal(save[4],'tesla-voice:v1:vehicle:action-a');
});

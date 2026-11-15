import test from 'node:test';
import assert from 'node:assert/strict';
import {gpsNavigationFenceStatus,withGPSFixtureNavigationFence} from './lib/gps-route-fixture-fence.mjs';
import {hash,seal,unseal} from './lib/security.mjs';

const subject='test-subject';
const vin='5YJ3E1EA7KF000000';
const config={env:{TESLA_VEHICLE_VIN:vin},key:Buffer.alloc(32,7)};
const baseKey='gps-fixture-navigation:'+hash(vin);
const plan=(lat,lon)=>({operation:'navigation_gps_request',args:{points:[{lat,lon}]}});
const fingerprint=p=>hash(subject+'\n'+vin+'\n'+p.operation+'\n'+JSON.stringify(Object.entries(p.args).sort(([a],[b])=>a.localeCompare(b))));
const request=id=>hash(subject+'\ns:'+id);

function fakeStore(seed={}){
 const values=new Map(Object.entries(seed));
 const active=new Set();
 return {
  values,
  async get(key){return values.get(key)??null;},
  async lock(key){
   if(active.has(key))throw Error('busy');
   active.add(key);
   return {
    async saveWithGuard(value,pendingKey,pendingValue,ttlSeconds,recordKey=key){
     if(values.has(pendingKey))return false;
     values.set(recordKey,value);values.set(pendingKey,pendingValue);return true;
    },
    async savePermanent(value,ttlSeconds,recordKey=key){values.set(recordKey,value);},
    async clearGuard(pendingKey,pendingValue){
     if(values.get(pendingKey)!==pendingValue)return 0;
     values.delete(pendingKey);return 1;
    },
    async release(){active.delete(key);}
   };
  }
 };
}
function uncertainSeed(p,requestId,{scoped=false}={}){
 const scope=fingerprint(p),key=scoped?baseKey+':'+scope:baseKey,owner='old-owner';
 const binding={fingerprint:scope,request:request(requestId)};
 const record={version:2,state:'in_flight',owner,subject_hash:hash(subject),operation:p.operation,...binding};
 const stateKey='direct-state:'+scope;
 const command={request:binding.request,operation:p.operation,state:'uncertain'};
 return {
  [key]:seal(record,config.key,key),
  [key+':pending']:owner,
  [stateKey]:seal(command,config.key,stateKey)
 };
}

test('a different explicit destination proceeds and preserves the legacy uncertain record',async()=>{
 const prior=plan(45.4642,9.19),next=plan(45.4773,9.1815);
 const priorData=uncertainSeed(prior,'prior-request'),store=fakeStore(priorData);
 const oldRecord=store.values.get(baseKey),oldGuard=store.values.get(baseKey+':pending');
 const status=await gpsNavigationFenceStatus({store,config,subject,plan:next});
 assert.equal(status.blocked,false);
 assert.equal(status.state,'unresolved_other_action');
 let passedScope;
 const result=await withGPSFixtureNavigationFence({store,config,subject,plan:next,requestId:'next-request',enabled:true,
  run:async fence=>{passedScope=fence.scope;return {accepted:true};}});
 assert.equal(result.accepted,true);
 assert.equal(passedScope,fingerprint(next));
 assert.equal(store.values.get(baseKey),oldRecord);
 assert.equal(store.values.get(baseKey+':pending'),oldGuard);
 const nextKey=baseKey+':'+fingerprint(next);
 const saved=unseal(store.values.get(nextKey),config.key,nextKey);
 assert.equal(saved.state,'acknowledged');
 assert.equal(store.values.has(nextKey+':pending'),false);
});

test('the same uncertain action remains blocked under a fresh request id',async()=>{
 const prior=plan(45.4642,9.19),store=fakeStore(uncertainSeed(prior,'prior-request'));
 let called=false;
 await assert.rejects(withGPSFixtureNavigationFence({store,config,subject,plan:prior,requestId:'fresh-request',enabled:true,
  run:async()=>{called=true;return {accepted:true};}}),/command_pending/);
 assert.equal(called,false);
 assert.equal(store.values.get(baseKey+':pending'),'old-owner');
});

test('an action-scoped uncertain guard also blocks an exact replay',async()=>{
 const prior=plan(45.4642,9.19),store=fakeStore(uncertainSeed(prior,'prior-request',{scoped:true}));
 let called=false;
 await assert.rejects(withGPSFixtureNavigationFence({store,config,subject,plan:prior,requestId:'fresh-request',enabled:true,
  run:async()=>{called=true;return {accepted:true};}}),/command_pending/);
 assert.equal(called,false);
 assert.equal(store.values.get(baseKey+':'+fingerprint(prior)+':pending'),'old-owner');
});

test('an unverifiable legacy guard remains fail-closed',async()=>{
 const store=fakeStore({[baseKey+':pending']:'legacy-owner',[baseKey]:'corrupt'});
 let called=false;
 await assert.rejects(withGPSFixtureNavigationFence({store,config,subject,plan:plan(45.4773,9.1815),requestId:'next-request',enabled:false,
  run:async()=>{called=true;return {accepted:true};}}),/command_pending/);
 assert.equal(called,false);
 assert.equal(store.values.get(baseKey+':pending'),'legacy-owner');
});

test('an acknowledged diagnostic guard releases for a new action and preserves its journal',async()=>{
 const first=plan(45.4642,9.19),next=plan(45.4773,9.1815),store=fakeStore();
 const diagnostic={phase:'replace',session_id:'a'.repeat(32),account_scope:'b'.repeat(64)};
 let diagnosticScope='unset';
 await withGPSFixtureNavigationFence({store,config,subject,plan:first,requestId:'diagnostic-replace',enabled:true,gpsDiagnostic:diagnostic,
  run:async fence=>{diagnosticScope=fence.scope;return {accepted:true};}});
 assert.equal(diagnosticScope,null);
 const oldRecord=store.values.get(baseKey),oldGuard=store.values.get(baseKey+':pending');
 const status=await gpsNavigationFenceStatus({store,config,subject,plan:next});
 assert.equal(status.blocked,true);
 assert.equal(status.releasable_on_new_explicit_action,true);
 let nextScope;
 await withGPSFixtureNavigationFence({store,config,subject,plan:next,requestId:'next-request',enabled:true,
  run:async fence=>{nextScope=fence.scope;return {accepted:true};}});
 assert.equal(nextScope,fingerprint(next));
 assert.equal(store.values.get(baseKey),oldRecord);
 assert.notEqual(store.values.get(baseKey+':pending'),oldGuard);
 assert.equal(store.values.has(baseKey+':pending'),false);
});

test('an uncertain diagnostic guard still blocks a different explicit action',async()=>{
 const first=plan(45.4642,9.19),next=plan(45.4773,9.1815),store=fakeStore();
 const diagnostic={phase:'replace',session_id:'c'.repeat(32),account_scope:'d'.repeat(64)};
 await assert.rejects(withGPSFixtureNavigationFence({store,config,subject,plan:first,requestId:'uncertain-diagnostic',enabled:true,gpsDiagnostic:diagnostic,
  run:async()=>{throw Error('command_outcome_unknown');}}),/command_outcome_unknown/);
 const status=await gpsNavigationFenceStatus({store,config,subject,plan:next});
 assert.equal(status.blocked,true);
 assert.equal(status.releasable_on_new_explicit_action,false);
 let called=false;
 await assert.rejects(withGPSFixtureNavigationFence({store,config,subject,plan:next,requestId:'next-action',enabled:true,
  run:async()=>{called=true;return {accepted:true};}}),/command_pending/);
 assert.equal(called,false);
 assert.ok(store.values.get(baseKey+':pending'));
});

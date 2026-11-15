import {hash,random,seal,unseal} from './security.mjs';

const navigationOperations=new Set(['navigation_request','navigation_gps_request','navigation_sc_request','navigation_waypoints_request']);
const digest=/^[A-Za-z0-9_-]{43}$/;
const diagnosticSession=/^[a-f0-9]{32}$/;
const diagnosticScope=/^[a-f0-9]{64}$/;
const diagnosticTTLSeconds=900;
const baseKey=config=>'gps-fixture-navigation:'+hash(config.env.TESLA_VEHICLE_VIN);
const keys=(config,scope=null)=>{
 const lockKey=baseKey(config),key=scope?lockKey+':'+scope:lockKey;
 return {key,pending:key+':pending',lockKey};
};
function commandFingerprint(subject,config,plan){
 const args=JSON.stringify(Object.entries(plan.args).sort(([a],[b])=>a.localeCompare(b)));
 return hash(subject+'\n'+config.env.TESLA_VEHICLE_VIN+'\n'+plan.operation+'\n'+args);
}
function commandBinding(subject,config,plan,requestId){
 const identifier=typeof requestId==='string'?'s:'+requestId:typeof requestId==='number'&&Number.isFinite(requestId)?'n:'+JSON.stringify(requestId):'';
 if(!identifier)throw Error('invalid_arguments');
 return {fingerprint:commandFingerprint(subject,config,plan),request:hash(subject+'\n'+identifier)};
}
function validRecord(record,owner,subject){
 if(record?.owner!==owner||record?.subject_hash!==hash(subject)||!digest.test(record.fingerprint)||!digest.test(record.request)||!navigationOperations.has(record.operation))return false;
 if(record.kind==='gps_diagnostic')return diagnosticSession.test(record.session_id)&&diagnosticScope.test(record.account_scope);
 return record.version===2;
}
async function readGuard({store,config,subject,guardKeys}){
 const owner=await store.get(guardKeys.pending);
 if(!owner)return null;
 try{
  const record=unseal(await store.get(guardKeys.key),config.key,guardKeys.key);
  if(!validRecord(record,owner,subject))return {owner,record:null,unverifiable:true,...guardKeys};
  return {owner,record,...guardKeys};
 }catch{return {owner,record:null,unverifiable:true,...guardKeys};}
}
function blockedStatus(guard,state,extra={}){
 return {blocked:true,retry_allowed:false,releasable_on_new_explicit_action:false,state,
  guard_owner:guard.owner,guard_pending:guard.pending,...extra};
}
async function statusForGuard({store,config,subject,guard}){
 if(guard.unverifiable)return blockedStatus(guard,'unverifiable');
 const record=guard.record;
 if(record.kind==='gps_diagnostic'){
  return {...blockedStatus(guard,record.state,{diagnostic_phase:record.phase,session_expires_at:record.expires_at}),
   releasable_on_new_explicit_action:['replace_accepted','append_accepted','replace_failed'].includes(record.state)};
 }
 const stateKey='direct-state:'+record.fingerprint;
 let command;
 try{command=unseal(await store.get(stateKey),config.key,stateKey);}catch{return blockedStatus(guard,'receipt_unavailable');}
 if(command?.request!==record.request||command.operation!==record.operation)return blockedStatus(guard,'receipt_mismatch');
 const accepted=command.state==='acknowledged'&&command.result_saved===true&&command.result?.accepted===true;
 const noEffect=command.state==='failed'; // Only definitive no-effect evidence permits releasing this action guard.
 return {...blockedStatus(guard,accepted?'acknowledged':noEffect?'failed':command.state==='uncertain'?'uncertain':'pending'),
  releasable_on_new_explicit_action:accepted||noEffect};
}

// Status is read-only. A legacy action guard applies only to its authenticated
// fingerprint; the two-phase GPS diagnostic retains a vehicle-wide guard.
// Unrelated action uncertainty remains stored and cannot block a different request.
export async function gpsNavigationFenceStatus({store,config,subject,plan}){
 const fingerprint=commandFingerprint(subject,config,plan);
 const scoped=keys(config,fingerprint);
 let guard=await readGuard({store,config,subject,guardKeys:scoped});
 if(guard&&guard.record?.fingerprint!==fingerprint)return blockedStatus(guard,'unverifiable');
 if(!guard){
  const legacy=await readGuard({store,config,subject,guardKeys:keys(config)});
  if(!legacy)return {blocked:false,state:'clear'};
  if(legacy.unverifiable)return blockedStatus(legacy,'unverifiable');
  if(legacy.record.kind!=='gps_diagnostic'&&legacy.record.fingerprint!==fingerprint)return {blocked:false,state:'unresolved_other_action',unresolved_action:true};
  guard=legacy;
 }
 return statusForGuard({store,config,subject,guard});
}

// A short per-vehicle lease still serializes live attempts. Permanent guards and
// journals are keyed by action (or diagnostic session), so unrelated requests
// cannot inherit an earlier uncertain outcome.
export async function withGPSFixtureNavigationFence({store,config,subject,plan,requestId,enabled=false,gpsDiagnostic=null,run}) {
 if(gpsDiagnostic&&(!diagnosticSession.test(gpsDiagnostic.session_id)||!diagnosticScope.test(gpsDiagnostic.account_scope)||!['replace','append'].includes(gpsDiagnostic.phase)))throw Error('invalid_arguments');
 const binding=commandBinding(subject,config,plan,requestId),owner=random();
 // Keep the two-phase diagnostic's vehicle-wide session guard. Ordinary
 // navigation actions use their own stable fingerprint scope.
 const scope=gpsDiagnostic?null:binding.fingerprint;
 const scoped=keys(config,scope),legacy=keys(config);
 let lock;
 try{lock=await store.lock(scoped.lockKey);}catch(error){if(error.message==='busy')throw Error('command_pending');throw error;}
 try{
  if(gpsDiagnostic){
   const d=gpsDiagnostic;
   let previous=await store.get(scoped.pending),record=null,activeKey=scoped.key,activePending=scoped.pending;
   try{const raw=await store.get(scoped.key);record=raw?unseal(raw,config.key,scoped.key):null;}catch{throw Error('command_pending');}
   if(record&&!validRecord(record,record.owner,subject))throw Error('command_pending');
   if(previous&&(!record||!validRecord(record,previous,subject)))throw Error('command_pending');
   if(!previous){
    const old=await readGuard({store,config,subject,guardKeys:legacy});
    if(old?.unverifiable)throw Error('command_pending');
    if(old&&(old.record.fingerprint===binding.fingerprint||
      (old.record.kind==='gps_diagnostic'&&old.record.session_id===d.session_id&&old.record.account_scope===d.account_scope))){
     previous=old.owner;record=old.record;activeKey=legacy.key;activePending=legacy.pending;
    }
   }
   if(previous){
    if(record?.kind!=='gps_diagnostic'||record.owner!==previous||record.subject_hash!==hash(subject)||record.session_id!==d.session_id||record.account_scope!==d.account_scope||record.expires_at_ms<=Date.now())throw Error('command_pending');
    if(d.phase==='replace'&&record.state==='replace_accepted')return {accepted:true,completed:false,phase:'replace',session_id:d.session_id,api_accepted:true,vehicle_route_verified:false,display_verified:false,dispatch_performed:false,result_reused:true,session_expires_at:record.expires_at};
    if(d.phase!=='append'||record.state!=='replace_accepted')throw Error('command_pending');
    const result=await run({owner:previous,scope:activeKey===legacy.key?'':scope});
    if(result?.accepted!==true)throw Error('command_outcome_unknown');
    record.state='append_accepted';record.phase='append';
    await lock.savePermanent(seal(record,config.key,activeKey),diagnosticTTLSeconds,activeKey);
    if(await lock.clearGuard(activePending,previous)!==1)throw Error('command_pending');
    return {...result,session_expires_at:record.expires_at};
   }
   if(d.phase==='append'){
    if(record?.kind==='gps_diagnostic'&&record.subject_hash===hash(subject)&&record.session_id===d.session_id&&record.account_scope===d.account_scope&&record.state==='append_accepted'&&record.expires_at_ms>Date.now())
     return {accepted:true,completed:false,phase:'append',session_id:d.session_id,api_accepted:true,accepted_stops:2,total_stops:2,vehicle_route_verified:false,display_verified:false,dispatch_performed:false,result_reused:true,session_expires_at:record.expires_at};
    throw Error('gps_diagnostic_session_invalid');
   }
   if(record?.kind==='gps_diagnostic'&&record.subject_hash===hash(subject)&&record.session_id===d.session_id&&record.account_scope===d.account_scope&&['replace_accepted','append_accepted'].includes(record.state)&&record.expires_at_ms>Date.now())
    return {accepted:true,completed:false,phase:record.phase,session_id:d.session_id,api_accepted:true,accepted_stops:record.state==='append_accepted'?2:1,total_stops:2,vehicle_route_verified:false,display_verified:false,dispatch_performed:false,result_reused:true,session_expires_at:record.expires_at};
   const recordValue={kind:'gps_diagnostic',owner,subject_hash:hash(subject),session_id:d.session_id,account_scope:d.account_scope,state:'replace_in_flight',phase:'replace',expires_at_ms:Date.now()+diagnosticTTLSeconds*1000,expires_at:new Date(Date.now()+diagnosticTTLSeconds*1000).toISOString(),operation:plan.operation,...binding};
   if(!await lock.saveWithGuard(seal(recordValue,config.key,scoped.key),scoped.pending,owner,diagnosticTTLSeconds,scoped.key))throw Error('command_pending');
   try{
    const result=await run({owner,scope});
    if(result?.accepted!==true)throw Error('command_outcome_unknown');
    if(result.result_reused===true&&Number.isFinite(Date.parse(result.session_expires_at))&&Date.parse(result.session_expires_at)<=Date.now()){
     await lock.clearGuard(scoped.pending,owner);
     throw Error('gps_diagnostic_session_invalid');
    }
    recordValue.state='replace_accepted';
    await lock.savePermanent(seal(recordValue,config.key,scoped.key),diagnosticTTLSeconds,scoped.key);
    return {...result,session_expires_at:recordValue.expires_at};
   }catch(error){
    if(error.commandStatus?.state==='failed'&&error.commandStatus?.command_reference===recordValue.request){
     await lock.savePermanent(seal({...recordValue,state:'replace_failed'},config.key,scoped.key),diagnosticTTLSeconds,scoped.key).catch(()=>{});
     await lock.clearGuard(scoped.pending,owner).catch(()=>{});
    }
    throw error;
   }
  }

  const evidence=await gpsNavigationFenceStatus({store,config,subject,plan});
  if(evidence.blocked){
   if(!evidence.releasable_on_new_explicit_action)throw Error('command_pending');
   if(await lock.clearGuard(evidence.guard_pending,evidence.guard_owner)!==1)throw Error('command_pending');
  }
  if(!enabled)return await run();
  const record={version:2,state:'in_flight',owner,subject_hash:hash(subject),operation:plan.operation,...binding};
  if(!await lock.saveWithGuard(seal(record,config.key,scoped.key),scoped.pending,owner,undefined,scoped.key))throw Error('command_pending');
  let result;
  try{result=await run({owner,scope});}
  catch(error){
   if(error.commandStatus?.state==='failed'&&error.commandStatus?.command_reference===binding.request)await lock.clearGuard(scoped.pending,owner);
   throw error;
  }
  if(result?.accepted!==true)throw Error('command_outcome_unknown');
  await lock.savePermanent(seal({...record,state:'acknowledged'},config.key,scoped.key),undefined,scoped.key);
  await lock.clearGuard(scoped.pending,owner);
  return result;
 }finally{await lock.release().catch(()=>{});}
}

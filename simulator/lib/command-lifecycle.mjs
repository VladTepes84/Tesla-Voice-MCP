import { hash, seal, unseal } from './security.mjs';
import { verifiedRuntimeFailureReceipt } from './command-runtime-recovery.mjs';

// No elapsed timeout proves that a dispatched command had no effect.
// The action record has no TTL; only definitive evidence permits another dispatch.
export function commandLifecycle({ store, config, now = Date.now }) {
  const context = (subject, plan, requestId) => {
    const args = JSON.stringify(Object.entries(plan.args).sort(([a], [b]) => a.localeCompare(b)));
    const fingerprint = hash(subject + '\n' + config.env.TESLA_VEHICLE_VIN + '\n' + plan.operation + '\n' + args);
    const identifier = typeof requestId === 'string' ? 's:' + requestId : typeof requestId === 'number' && Number.isFinite(requestId) ? 'n:' + JSON.stringify(requestId) : '';
    if (requestId !== undefined && (identifier.length < 3 || identifier.length > 258)) throw Error('invalid_arguments');
    const request = hash(subject + '\n' + identifier);
    return { fingerprint, request, key: 'direct-state:' + fingerprint, resultKey: 'direct-result:' + request + ':' + fingerprint,
      requestKey: 'direct-command:' + request + ':' + fingerprint, pendingKey: 'direct-pending:' + fingerprint };
  };
  function decodeJournal(raw, key) {
    const record=unseal(raw,config.key,key);
    if(!record||typeof record!=='object'||Array.isArray(record)||!['created','dispatched','acknowledged','failed','uncertain'].includes(record.state)||
      record.request!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(record.request))throw Error('invalid_journal');
    return record;
  }
  const read = async key => {
    const raw = await store.get(key);
    try { return raw ? decodeJournal(raw, key) : null; }
    catch { const error = Error('store');error.commandJournalInvalid=true;throw error; }
  };
  const view = record => record ? {
    state: record.state, command_reference: record.request ?? null,
    backend_received: true, proxy_accepted: record.proxy_accepted ?? null,
    tesla_accepted: record.tesla_accepted ?? null, completed: false,
    navigation_set: 'unverified', iphone_app_sync: 'not_verifiable',
    created_at: record.created_at, updated_at: record.updated_at,
    reason: record.reason ?? null, retry_allowed: record.state === 'failed',
    new_explicit_action_allowed: record.state === 'failed' || (record.state === 'acknowledged' && record.result_saved === true),
    retry_requires_new_explicit_request: true
  } : { state: 'not_found', backend_received: null, retry_allowed: false };
  const fail = (code, record) => { const error = Error(code); error.commandStatus = view(record); throw error; };
  async function save(lock, key, record) {
    record.updated_at = new Date(now()).toISOString();
    await lock.savePermanent(seal(record, config.key, key));
  }
  async function releaseGuard(lock, c, record) {
    await lock.clearGuard(c.pendingKey, 'lifecycle-v1:' + record.request);
  }
  async function reconcile(c, lock, preserveGuards = false) {
    let record = await read(c.key);
    if (!record && await store.get(c.pendingKey)) {
      record = { state: 'uncertain', created_at: new Date(now()).toISOString(), reason: 'legacy_pending_without_receipt' };
      await save(lock, c.key, record);
      await store.persist(c.pendingKey);
    }
    if (!record) return null;
    if (record.state === 'created') {
      // Acquiring its lease means the earlier owner is gone/expired. Its fenced
      // save before dispatch will fail, so that worker cannot subsequently send.
      const guard = await store.get(c.pendingKey);
      record.state = guard && guard !== 'lifecycle-v1:' + record.request ? 'uncertain' : 'failed';
      record.reason = record.state === 'failed' ? 'command_not_dispatched' : 'legacy_pending_without_receipt';
      await save(lock, c.key, record);
      if (record.state === 'failed' && !preserveGuards) await releaseGuard(lock, c, record);
    }
    if (record.nonce && ['dispatched', 'uncertain'].includes(record.state)) {
      const receiptKey='command-proxy-receipt:'+record.nonce;
      let raw = await store.get(receiptKey);
      if(!raw){
        const verified=verifiedRuntimeFailureReceipt(record,now());
        if(verified){await store.putOncePermanent(receiptKey,JSON.stringify(verified));raw=await store.get(receiptKey);}
      }
      let receipt;
      try { receipt = raw ? JSON.parse(raw) : null; } catch { /* No usable evidence. */ }
      if (receipt?.version === 1 && receipt.nonce === record.nonce &&
          (receipt.state === 'acknowledged' || (receipt.state === 'failed' && receipt.definitive_no_effect === true))) {
        record.state = receipt.state; record.proxy_accepted = receipt.proxy_accepted===false?false:true;
        record.tesla_accepted = receipt.state === 'acknowledged';
        record.reason = receipt.state === 'failed' ? (receipt.reason==='command_not_dispatched'?'command_not_dispatched':'command_rejected') : null;
        if (record.state === 'acknowledged') {
          record.result = accepted(record.operation);
          await store.put('direct-result:' + record.request, JSON.stringify({ fingerprint: c.fingerprint, result: record.result }), 86400);
          record.result_saved = true;
        }
        await save(lock, c.key, record);
        if (!preserveGuards) await releaseGuard(lock, c, record);
      } else if (receipt?.version === 1 && receipt.nonce === record.nonce && receipt.state === 'uncertain') {
        record.state = 'uncertain'; record.proxy_accepted = true; record.reason = 'proxy_outcome_unknown';
        await save(lock, c.key, record);
      } else if (record.state === 'dispatched' && now() >= record.deadline) {
        record.state = 'uncertain'; record.reason = 'dispatch_deadline_elapsed';
        await save(lock, c.key, record);
      }
    }
    return record;
  }
  function accepted(operation) {
    return { operation, accepted: true, completed: false,
      evidence: { backend_received: true, proxy_accepted: true, tesla_accepted: true, navigation_set: 'unverified', iphone_app_sync: 'not_verifiable' },
      ...(operation === 'navigation_request' ? { navigation_verification: { tool: 'get_vehicle_location', requires_separate_explicit_request: true,
        automatic_read: false, note: 'Any active_route_destination is a separate snapshot with no identifier that can be correlated to the command; it does not verify synchronization with iPhone.' } } : {}),
      note: 'Tesla accepted the request. The command result does not prove that the vehicle completed the action.' };
  }
  function referenceContext(subject) { return 'command-status-reference:' + hash(config.issuer + '\n' + subject + '\n' + config.env.TESLA_VEHICLE_VIN); }
  function reference(subject,plan) { return seal({version:1,fingerprint:context(subject,plan).fingerprint,operation:plan.operation},config.key,referenceContext(subject)); }
  async function status(subject, plan, selector = {}) {
    let c, operation = plan?.operation, mode = 'exact_arguments';
    if (selector.statusReference !== undefined) {
      let reference;
      try { reference = unseal(selector.statusReference, config.key, referenceContext(subject)); } catch { throw Error('invalid_arguments'); }
      if (reference?.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(reference.fingerprint) || typeof reference.operation !== 'string') throw Error('invalid_arguments');
      if (operation && operation !== reference.operation) throw Error('invalid_arguments');
      operation = reference.operation;
      c = { fingerprint:reference.fingerprint,key:'direct-state:'+reference.fingerprint,pendingKey:'direct-pending:'+reference.fingerprint };
      mode = 'status_reference';
    } else if (selector.requestId !== undefined) {
      const request = context(subject, {operation:'lookup',args:{}}, selector.requestId).request;
      const cached = await store.get('direct-result:' + request);
      let saved;
      try { saved = cached ? JSON.parse(cached) : null; } catch { throw Error('store'); }
      if(saved && (!/^[A-Za-z0-9_-]{43}$/.test(saved.fingerprint) || saved.result?.accepted!==true))throw Error('store');
      if(saved && operation && saved.result.operation!==operation)throw Error('invalid_arguments');
        let cursor='0', incomplete=false, corrupt=false;
        const found=new Map(), deadline=Date.now()+4500;
        for(let page=0;page<4;page++) {
          const remaining=deadline-Date.now();if(remaining<100){incomplete=true;break;}
          const data=await store.commandStatePage(cursor,Math.min(1500,remaining));
          if(data.truncated)incomplete=true;
          for(const [fullKey,encrypted] of data.records) {
            const key=fullKey.replace(/^tesla-voice:v1:/,'');
            if(!/^direct-state:[A-Za-z0-9_-]{43}$/.test(key)){corrupt=true;continue;}
            let record;try{record=decodeJournal(encrypted,key);}catch{corrupt=true;continue;}
            if(record.request===request)found.set(key,record);
          }
          cursor=data.cursor;if(cursor==='0')break;
        }
        if(cursor!=='0'||corrupt)incomplete=true;
        if(found.size===0 && !incomplete && saved?.result?.accepted===true)return {
          state:'legacy_result_only',retry_allowed:false,accepted:true,completed:false,operation:saved.result.operation??null,
          lookup:{mode:'original_request_id',complete:false,legacy_pending_without_journal_searchable:false,no_match_proves_no_dispatch:false}
        };
        if(found.size!==1||incomplete)return {state:found.size>1?'ambiguous_command':incomplete?'lookup_incomplete':'not_found',retry_allowed:false,
          lookup:{mode:'original_request_id',complete:!incomplete,matched_records:found.size,legacy_pending_without_journal_searchable:false,no_match_proves_no_dispatch:false}};
        const [key,record]=[...found][0];
        if(operation&&operation!==record.operation)throw Error('invalid_arguments');
        operation=record.operation;c={fingerprint:key.slice('direct-state:'.length),key,pendingKey:'direct-pending:'+key.slice('direct-state:'.length)};
      const matchedRecord=await read(c.key);
      if(matchedRecord && (matchedRecord.request!==request || (operation && matchedRecord.operation && operation!==matchedRecord.operation)))throw Error('invalid_arguments');
      operation=matchedRecord?.operation??operation;
      if(!matchedRecord)return {state:'legacy_result_only',retry_allowed:false,lookup:{mode:'original_request_id',complete:false,no_match_proves_no_dispatch:false},
        accepted:saved?.result?.accepted===true?true:null,completed:false};
      mode='original_request_id';
    } else c = context(subject, plan);
    const wrap = record => ({...view(record),lookup:{mode,complete:true,no_match_proves_no_dispatch:false,representation_sensitive:mode==='exact_arguments'},
      ...(record ? {status_reference:seal({version:1,fingerprint:c.fingerprint,operation:operation??record.operation},config.key,referenceContext(subject))}: {})});
    let lock;
    try { lock = await store.lock(c.key); }
    catch (error) { if (error.message !== 'busy') throw error; return wrap(await read(c.key)); }
    try {
      const record = await reconcile(c, lock, true);
      if (record?.state === 'acknowledged' && record.result_saved !== true && record.result) {
        await store.put('direct-result:' + record.request, JSON.stringify({ fingerprint: c.fingerprint, result: record.result }), 86400);
        record.result_saved = true; await save(lock, c.key, record);
      }
      return wrap(record);
    } finally { await lock.release().catch(() => {}); }
  }
  async function execute(subject, plan, requestId, dispatch) {
    const c = context(subject, plan, requestId);
    const current = await store.get(c.resultKey);
    const legacy = current ? null : await store.get('direct-result:' + c.request);
    let cached = current;
    if (!cached && legacy) {
      let previous; try { previous=JSON.parse(legacy); } catch { fail('command_pending'); }
      if(previous.fingerprint===c.fingerprint)cached=legacy;
    }
    if (cached) {
      let previous; try { previous = JSON.parse(cached); } catch { fail('command_pending'); }
      if (previous.fingerprint !== c.fingerprint) fail('command_replayed');
      if (previous.result?.accepted === true) return {...previous.result,dispatch_performed:false,result_reused:true};
      fail('command_pending');
    }
    let lock;
    try { lock = await store.lock(c.key); }
    catch (error) { if (error.message !== 'busy') throw error; fail('command_pending', await read(c.key)); }
    let record;
    try {
      record = await reconcile(c, lock);
      if(record && (record.state==='failed'||record.state==='acknowledged'&&record.result_saved))await releaseGuard(lock,c,record);
      if (record?.request === c.request && record.state === 'acknowledged' && record.result_saved) return {...record.result,dispatch_performed:false,result_reused:true};
      if (record?.state === 'failed' && record.request === c.request) fail(record.reason, record);
      if (record && (['dispatched', 'uncertain'].includes(record.state) || (record.state === 'acknowledged' && !record.result_saved))) fail('command_pending', record);
      if (!await store.once(c.requestKey, 86400)) fail('command_request_replayed', record);
      record = { state: 'created', request: c.request, operation: plan.operation, created_at: new Date(now()).toISOString(), result_saved: false };
      await save(lock, c.key, record);
      let dispatched = false, acknowledged = false;
      try {
        const result = await dispatch(async nonce => {
          record.state = 'dispatched'; record.nonce = nonce; record.deadline = now() + 15_000;
          record.updated_at = new Date(now()).toISOString();
          if (!await lock.saveWithGuard(seal(record, config.key, c.key), c.pendingKey, 'lifecycle-v1:' + record.request)) {
            record.state = 'uncertain'; record.reason = 'legacy_pending_without_receipt';
            await save(lock, c.key, record); await store.persist(c.pendingKey);
            fail('command_pending', record);
          }
          dispatched = true;
        });
        acknowledged = true;
        record.state = 'acknowledged'; record.proxy_accepted = true; record.tesla_accepted = true;
        record.result = { ...result, ...accepted(plan.operation),status_reference:reference(subject,plan) };
        await save(lock, c.key, record);
        await store.put(c.resultKey, JSON.stringify({ fingerprint: c.fingerprint, result: record.result }), 86400);
        record.result_saved = true; await save(lock, c.key, record);
        await releaseGuard(lock, c, record);
        return {...record.result,dispatch_performed:true,result_reused:false};
      } catch (error) {
        if (!acknowledged) {
          record.state = record.reason === 'legacy_pending_without_receipt' ? 'uncertain' : !dispatched || error.definitiveNoEffect === true ? 'failed' : 'uncertain';
          if (error.proxyAccepted === true) record.proxy_accepted = true;
          if (dispatched && error.definitiveNoEffect === true) record.tesla_accepted = false;
          record.reason = record.reason === 'legacy_pending_without_receipt' ? record.reason : new Set(['permission','budget','reauthorize','configuration','store','busy','disabled','invalid_arguments','command_rejected','vehicle_unavailable','virtual_key_unpaired','command_budget_replayed','command_outcome_unknown','command_unavailable','command_upstream_unavailable']).has(error.message) ? error.message : 'command_outcome_unknown';
          try { await save(lock, c.key, record); if (record.state === 'failed') await releaseGuard(lock, c, record); } catch { /* Retain the guard if persistence failed. */ }
        }
        error.commandStatus = view(record); throw error;
      }
    } finally { await lock.release().catch(() => {}); }
  }
  return { execute, status, reference };
}

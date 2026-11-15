import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './worker.mjs';
import { request } from './offline-request.mjs';
import { safeToolFailure } from './lib/tool-errors.mjs';

test('safe errors expose only known categories and never arbitrary upstream text', () => {
  for(const code of ['budget','rate','reauthorize','store','permission','vehicle_unavailable','upstream','invalid_arguments','unsupported_operation','command_budget_replayed','invalid_confirmation','expired_or_used_confirmation','confirmation_context_mismatch']) {
    assert.equal(safeToolFailure(Error(code)).error.code,code);
  }
  for(const err of [Error('PRIVATE_TOKEN_VIN_URL_BODY'), null, new TypeError('PRIVATE_PAYLOAD')]) {
    const result=safeToolFailure(err);
    assert.equal(result.error.code,'internal_error');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  }
});

test('command status diagnostics contain only fixed stages, never raw errors or arguments',()=>{
 const known=Object.assign(Error('invalid_arguments'),{commandStatusStage:'status_selector_validation'});
 assert.equal(safeToolFailure(known).error.code,'invalid_arguments');
 assert.equal(safeToolFailure(known).diagnostic.stage,'status_selector_validation');
 const unknown=Object.assign(Error('PRIVATE_TOKEN_URL'),{commandStatusStage:'PRIVATE_GPS'});
 assert.equal(safeToolFailure(unknown).error.code,'internal_error');
 assert.doesNotMatch(JSON.stringify(safeToolFailure(unknown)),/PRIVATE/);
});

test('vehicle_unavailable explains the direct recovery path without waking or retrying', () => {
  const result=safeToolFailure(Error('vehicle_unavailable')).error;
  assert.equal(result.code,'vehicle_unavailable');
  assert.match(result.message,/offline or asleep/);
  assert.match(result.message,/No automatic attempt will be made/);
  assert.match(result.message,/explicitly request one wake_up command/);
  assert.match(result.message,/approval prompt/);
  assert.match(result.message,/10–60 seconds/);
});

test('both MCP transports preserve request id and report tool failure without retries', async () => {
  for(const legacy of [false,true]) {
    let calls=0;
    const worker=createWorker({
      invokeTool:async()=>{ calls++;throw Error('vehicle_unavailable'); },
      onToolError:safeToolFailure
    });
    const req=legacy
      ? new Request('https://example.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
          body:JSON.stringify({jsonrpc:'2.0',id:'failure-42',method:'tools/call',params:{name:'get_simulated_battery',arguments:{}}})})
      : request('tools/call',{name:'get_simulated_battery',arguments:{}});
    const response=await worker.fetch(req);
    assert.equal(response.status,200);
    const rpc=await response.json();
    assert.equal(rpc.id,legacy?'failure-42':1);
    assert.equal(rpc.result.isError,true);
    assert.equal(JSON.parse(rpc.result.content[0].text).error.code,'vehicle_unavailable');
    assert.equal(calls,1);
  }
});

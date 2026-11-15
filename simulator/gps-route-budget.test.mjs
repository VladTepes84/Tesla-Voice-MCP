import test from 'node:test';
import assert from 'node:assert/strict';
import {withGPSExecutionBudget,GPS_EXECUTION_BUDGET_MS} from './lib/gps-route-execution-budget.mjs';

test('candidate absolute budget reserves Vercel response margin and cannot be increased',async()=>{
 assert.equal(GPS_EXECUTION_BUDGET_MS,24000);assert.ok(GPS_EXECUTION_BUDGET_MS<30000);
 await assert.rejects(withGPSExecutionBudget(()=>{}, {timeoutMs:30000}),/configuration/);
});
test('slow preflight cannot dispatch after deadline even if it ignores cancellation',async()=>{
 let release;const gate=new Promise(r=>release=r);let sent=0,signal;
 const started=Date.now();
 await assert.rejects(withGPSExecutionBudget(async budget=>{signal=budget.signal;await gate;budget.assertActive();sent++;},{timeoutMs:30}),/command_outcome_unknown/);
 assert.ok(Date.now()-started<1000);assert.equal(signal.aborted,true);release();
 await new Promise(r=>setImmediate(r));assert.equal(sent,0);
});
test('a slow in-flight transport gets aborted, never turns timeout into acceptance',async()=>{
 let sends=0,aborted=false;
 await assert.rejects(withGPSExecutionBudget(async budget=>{
  budget.assertActive();sends++;
  await new Promise(resolve=>budget.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
  budget.assertActive();return {accepted:true};
 },{timeoutMs:30}),/command_outcome_unknown/);
 assert.equal(sends,1);assert.equal(aborted,true);
});

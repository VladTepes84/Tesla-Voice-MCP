// One absolute candidate execution deadline, including Redis/auth/preflight.
// No Promise.race may authorize a later send: every send boundary must call
// assertActive and pass this signal to its fetch. Late writes may retain guards;
// elapsed time never authorizes guard deletion or command retransmission.
export const GPS_EXECUTION_BUDGET_MS=24000;
export async function withGPSExecutionBudget(run,{timeoutMs=GPS_EXECUTION_BUDGET_MS}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>GPS_EXECUTION_BUDGET_MS)throw Error('configuration');
 const controller=new AbortController(),deadlineMs=Date.now()+timeoutMs;
 let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('command_outcome_unknown'));},timeoutMs);});
 const assertActive=()=>{if(controller.signal.aborted||Date.now()>=deadlineMs)throw Error('command_outcome_unknown');};
 try{return await Promise.race([Promise.resolve().then(()=>run({signal:controller.signal,deadlineMs,assertActive})),timeout]);}
 finally{clearTimeout(timer);controller.abort();}
}

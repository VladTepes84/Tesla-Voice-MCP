// One audited historical recovery, not a client-supplied assertion or a timeout.
// Vercel recorded this POST exiting in the Lambda bootstrap before Handler ran:
// failed to get the next invoke ... /runtime/invocation/next: outbound destination denied.
// No arbitrary record or caller-provided evidence can enter this path.
export function verifiedRuntimeFailureReceipt(record, now) {
  if(record?.state!=='uncertain'||record.request!=='X-DUvqKOrThV05FFN0LqfuDfNnmOAYFgyGA8QgM7ZwQ'||
     record.operation!=='navigation_request'||record.reason!=='command_unavailable'||
     record.created_at!=='2026-11-04T21:30:56.519Z'||record.updated_at!=='2026-11-04T21:30:57.420Z'||
     !/^[A-Za-z0-9_-]{43}$/.test(record.nonce)||now<Date.parse('2026-11-04T21:30:57.414Z'))return null;
  return {version:1,nonce:record.nonce,state:'failed',definitive_no_effect:true,proxy_accepted:false,
    reason:'command_not_dispatched',source:'verified_vercel_bootstrap_failure',
    observed_at:new Date(now).toISOString(),evidence:{
      deployment_id:'dpl_27s1XigWhNV9p6guSvKTei1vnDvo',commit:'8efc7876a6ef0e1b5ca5e4f0ca0f2678fc5fc94e',
      proxy_request_id:'mjm8f-1793827857210-1666bce97069',log_at:'2026-11-04T21:30:57.414Z',
      failure:'runtime_invocation_next_denied_before_handler'}};
}

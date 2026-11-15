// Absolute request deadlines, including headers, body reads and non-cooperative mocks.
export const PLANNER_BUDGET_MS=20000;
export const CATALOG_BUDGET_MS=13000;
const expired=()=>new DOMException('request_budget_exhausted','TimeoutError');
export function withinDeadline(run,deadline,onTimeout=()=>{}){
 const left=deadline-Date.now();
 const cleanup=()=>{try{onTimeout();}catch{}};
 if(left<=0){cleanup();return Promise.reject(expired());}
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(expired());},left);
  Promise.resolve().then(run).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
 });
}
export function deadlineFetcher(fetcher,deadline){
 return async(url,init={})=>{
  const controller=new AbortController();
  const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
  const r=await withinDeadline(()=>fetcher(url,{...init,signal}),deadline,()=>controller.abort(expired()));
  if(!r.body)return r;
  return {ok:r.ok,status:r.status,headers:r.headers,body:{getReader(){
   const reader=r.body.getReader();
   return {read:()=>withinDeadline(()=>reader.read(),deadline,()=>{
    controller.abort(expired());Promise.resolve(reader.cancel()).catch(()=>{});
   }),cancel:reason=>{controller.abort();Promise.resolve(reader.cancel(reason)).catch(()=>{});return Promise.resolve();}};
  }}};
 };
}

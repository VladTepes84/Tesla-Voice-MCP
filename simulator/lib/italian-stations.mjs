import {deadlineFetcher,CATALOG_BUDGET_MS} from './request-deadline.mjs';
// Official AgID publication of GSE/PUN data. Selected municipality shards,
// NOT a complete Italian catalog. No Cognito credentials or original API access.
export const IT_BASE='https://cruscotto-italia.dati.gov.it/data/pun/';
export const IT_SHARDS=['015146','097042','097023','013075','003106','007003','014048','014018'];
const caches=new WeakMap(),acCaches=new WeakMap();
const clean=s=>String(s??'').replace(/[\x00-\x1f<>]/g,' ').slice(0,200);
export function normalizeItalianShard(data,{url,fetchedAt=new Date().toISOString(),now=Date.now(),includeAc=false}={}){
 if(!data||!Array.isArray(data.punti)||!String(data._license).startsWith('CC BY 4.0')||!String(data._source).includes('GSE')||
 data._source_url!=='https://www.piattaformaunicanazionale.it/idr')throw Error('italian_schema_or_license');
 const snapshot=Date.parse(data._snapshot_date),generated=Date.parse(data._generated_at);
 if(!Number.isFinite(snapshot)||!Number.isFinite(generated)||now-snapshot>7*86400000||snapshot>now+86400000)throw Error('italian_stale');
 return data.punti.flatMap(p=>{
  const dc=p.standard_connettore==='IEC_62196_T2_COMBO'&&p.corrente==='DC';
  const ac=includeAc&&p.standard_connettore==='IEC_62196_T2'&&['AC','AC_1_PHASE','AC_3_PHASE'].includes(p.corrente);
  if((!dc&&!ac)||p.stato!=='Attivo'||p.publication_status!=='PUBLISHED'||
   typeof p.id_evse!=='string'||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||p.lat<35||p.lat>47.5||p.lon<6||p.lon>19||
   !Number.isFinite(p.potenza_w)||p.potenza_w<=0||p.potenza_w>1000000||['PRIVATE','RESIDENTIAL'].includes(p.tipo_parcheggio))return [];
  return [{id:clean(p.id_evse),lat:p.lat,lon:p.lon,country:'IT',name:clean(p.indirizzo),operator:clean(p.cpo),
   ccs2:dc,connectorType:dc?'CCS2':'AC',power_kw:p.potenza_w/1000,availability:'unknown',availability_updated_at:null,tariff:null,
   source:'IT_AGID_GSE_PUN',source_url:url,upstream_source_url:data._source_url,source_updated_at:new Date(snapshot).toISOString(),
   record_updated_at:null,fetched_at:fetchedAt,license:'CC-BY-4.0',attribution:'GSE/MASE PUN via AgID Cruscotto Italia, CC BY 4.0',
   access:'public register',motorway_access:'unknown',open_24h_reported:p.open_24h7===true}];
 });
}
export async function loadItalianStations({fetcher=fetch,deadline=Date.now()+CATALOG_BUDGET_MS,includeAc=false}={}){
 const cache=includeAc?acCaches:caches;
 const old=cache.get(fetcher);if(old?.expires>Date.now())return old.value;if(old?.pending)return old.pending;
 const run=(async()=>{
  const bounded=deadlineFetcher(fetcher,deadline);
  const results=await Promise.allSettled(IT_SHARDS.map(async id=>{
   const url=IT_BASE+id+'.json',r=await bounded(url,{redirect:'error',headers:{'user-agent':'TeslaVoiceMCP/1.0'}});
   if(!r.ok)throw Error('italian_http_'+r.status);
   const reader=r.body.getReader(),chunks=[];let bytes=0;
   while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8000000){await reader.cancel();throw Error('italian_size');}chunks.push(value);}
   return normalizeItalianShard(JSON.parse(Buffer.concat(chunks).toString()),{url,includeAc});
  }));
  const stations=[...new Map(results.flatMap(r=>r.status==='fulfilled'?r.value:[]).map(s=>[s.id,s])).values()];
  if(results.every(r=>r.status==='rejected'))throw Error('italian_catalog_unavailable');
  const value={stations,source_url:IT_BASE,source_updated_at:stations.map(s=>s.source_updated_at).sort()[0]||null,
   complete:false,issue:results.some(r=>r.status==='rejected')?'selected_municipalities_partial':'selected_municipalities_only',
   municipality_sources:results.map((r,i)=>({municipality_id:IT_SHARDS[i],status:r.status==='fulfilled'?'ok':'unavailable',station_count:r.status==='fulfilled'?r.value.length:0,...(r.status==='rejected'?{reason:/^italian_[a-z0-9_]+$/.test(r.reason?.message)?r.reason.message:'italian_network_or_timeout'}:{})})),
   municipality_ids:IT_SHARDS,municipalities_loaded:results.filter(r=>r.status==='fulfilled').length,
   attribution:'GSE/MASE PUN via AgID Cruscotto Italia, CC BY 4.0'};
  cache.set(fetcher,{value,expires:Date.now()+3600000});return value;
 })();cache.set(fetcher,{pending:run});
 try{return await run;}catch(e){cache.delete(fetcher);throw e;}
}

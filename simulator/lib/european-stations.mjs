import { loadItalianStations } from './italian-stations.mjs';
import { deadlineFetcher, CATALOG_BUDGET_MS } from './request-deadline.mjs';
import { loadSwissStations } from './national-stations.mjs';
const FR_META='https://www.data.gouv.fr/api/1/datasets/5448d3e0c751df01f85d0572/';
const DE_PAGE='https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/DownloadundKontakt.html';
const clean=v=>String(v??'').replace(/[\x00-\x1f<>]/g,' ').slice(0,200);
const decimal=v=>Number(String(v??'').replace(',','.'));
const date=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
export class CsvParser {
 constructor(delimiter=','){this.delimiter=delimiter;this.field='';this.row=[];this.quoted=false;this.pending=false;}
 write(text,emit){
  for(const ch of text){
   if(this.pending){this.pending=false;if(ch==='"'){this.field+='"';continue;}this.quoted=false;}
   if(ch==='"'){if(this.quoted)this.pending=true;else if(!this.field)this.quoted=true;else throw Error('csv_quote');}
   else if(this.quoted)this.field+=ch;
   else if(ch===this.delimiter){this.row.push(this.field);this.field='';}
   else if(ch==='\n'){this.row.push(this.field);emit(this.row);this.row=[];this.field='';}
   else if(ch!=='\r')this.field+=ch;
   if(this.field.length>64000||this.row.length>250)throw Error('csv_bounds');
  }
 }
 finish(emit){if(this.quoted&&!this.pending)throw Error('csv_incomplete');if(this.field||this.row.length){this.row.push(this.field);emit(this.row);} }
}
function base(id,lat,lon,country,meta){
 if(!id||!Number.isFinite(lat)||!Number.isFinite(lon)||lat<34||lat>72||lon< -25||lon>45)return null;
 return {id:clean(id),lat,lon,country,ccs2:true,availability:'unknown',availability_updated_at:null,tariff:null,record_updated_at:null,...meta};
}
export function normalizeIrve(r,meta={}, {includeAc=false}={}){
 const dc=/^(true|1)$/i.test(r.prise_type_combo_ccs||'');
 const ac=includeAc&&!dc&&/^(true|1)$/i.test(r.prise_type_2||'')&&!/^(true|1)$/i.test(r.prise_type_chademo||'');
 if((!dc&&!ac)||r.condition_acces!=='Accès libre'||/^(true|1)$/i.test(r.station_deux_roues||''))return [];
 const id=r.id_pdc_itinerance;
 if(!id||/non concern/i.test(id))return [];
 let xy;try{xy=JSON.parse(r.coordonneesXY);}catch{return [];}
 const prefix=/^[A-Z]{2}/.exec(id)?.[0];
 const country=/^true$/i.test(r.consolidated_is_code_insee_verified||'')?'FR':null;
 if(!prefix||!Array.isArray(xy)||xy.length!==2)return [];
 const power=decimal(r.puissance_nominale);if(!(power>0&&power<=1000))return [];
 const item=base(id,Number(xy[1]),Number(xy[0]),country,meta);
 if(!item)return [];
 return [{...item,ccs2:dc,connectorType:dc?'CCS2':'AC',name:clean(r.nom_station),operator:clean(r.nom_operateur),power_kw:power,
 evse_country_prefix:prefix,record_updated_at:date(r.date_maj),access:r.condition_acces,motorway_access:'unknown',station_id:clean(r.id_station_itinerance)}];
}
export function normalizeBnetza(r,meta={}, {includeAc=false}={}){
 if(r['Status']&&r['Status']!=='In Betrieb')return [];
 const lat=decimal(r.Breitengrad),lon=decimal(r['Längengrad']);
 if(lat<47||lat>56||lon<5||lon>16)return [];
 const stations=[];
 for(let n=1;n<=20;n++){
  const plug=r['Steckertypen'+n]||r['Steckertypen '+n]||'';
  const dc=/\bDC\b.*(?:\bCombo\s*2\b|\bCCS\s*2\b)/i.test(plug);
  const ac=includeAc&&!dc&&/\bAC\b.*\bTyp\s*2\b/i.test(plug);
  if(!dc&&!ac)continue;
  // Power belongs to the same numbered point, never the station connection.
  const values=String(r['Nennleistung Stecker'+n]||r['P'+n+' [kW]']||r['P'+n]||r['Leistung Ladepunkt '+n+' [kW]']||'').split(';').map(decimal);
  const types=plug.split(';');
  if(types.length!==values.length)continue;
  const matching=types.flatMap((p,i)=>(dc?/\bDC\b.*(?:\bCombo\s*2\b|\bCCS\s*2\b)/i.test(p):/\bAC\b.*\bTyp\s*2\b/i.test(p))?[values[i]]:[]).filter(p=>Number.isFinite(p)&&p>0&&p<=1000);
  const power=matching.length?Math.max(...matching):NaN;
  if(!(power>0&&power<=1000))continue;
  const id=r['Ladeeinrichtungs-ID']||r['Ladeeinrichtungs-ID (BNetzA)']||[r.Betreiber,r.Ort,r['Straße'],r.Hausnummer,lat,lon].join('|');
  const item=base(r['EVSE-ID'+n]||id+':'+n,lat,lon,'DE',meta);
  if(item)stations.push({...item,ccs2:dc,connectorType:dc?'CCS2':'AC',name:clean([r.Ort,r['Straße'],r.Hausnummer].filter(Boolean).join(' ')),operator:clean(r.Betreiber),power_kw:power,access:'public register',motorway_access:'unknown'});
 }
 return stations;
}
async function response(url,fetcher,allowed,extraHeaders={},timeoutMs=18000){
 let current=url;
 for(let n=0;n<4;n++){
  const u=new URL(current);if(u.protocol!=='https:'||u.username||u.password||!allowed.includes(u.hostname))throw Error('feed_origin');
  const r=await fetcher(current,{redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{'user-agent':'TeslaVoiceMCP/1.0',...extraHeaders}});
  if(r.status>=300&&r.status<400){const next=r.headers.get('location');if(!next)throw Error('feed_redirect');current=new URL(next,current).href;continue;}
  if(!r.ok)throw Error('feed_http_'+r.status);return r;
 }
 throw Error('feed_redirect_limit');
}
async function text(url,fetcher,allowed){
 const r=await response(url,fetcher,allowed);const reader=r.body.getReader(),parts=[];let bytes=0;
 while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2000000){await reader.cancel();throw Error('metadata_size');}parts.push(value);}
 return Buffer.concat(parts).toString();
}
export function germanCsvLink(html){
 const links=[...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m=>new URL(m[1].replaceAll('&amp;','&'),DE_PAGE)).filter(u=>u.protocol==='https:'&&['www.bundesnetzagentur.de','data.bundesnetzagentur.de'].includes(u.hostname)&&/\.csv(?:$|[?])/i.test(u.href)&&(u.pathname.startsWith('/SharedDocs/Downloads/')||u.hostname==='data.bundesnetzagentur.de'&&u.pathname.startsWith('/Bundesnetzagentur/')));
 if(!links.length)throw Error('german_csv_link_not_found');
 return links[0].href;
}
async function csv(url,fetcher,allowed,normalize,meta){
 const r=await response(url,fetcher,allowed);let reader=r.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
 const modified=date(r.headers.get('last-modified'))||meta.source_updated_at||null;
 const fullMeta={...meta,source_url:url,source_updated_at:modified,fetched_at:new Date().toISOString()};
 let complete=true,issue=null;
 const stations=new Map();let bytes=0,header=null,parser=null,preamble='',rows=0;
 const emit=values=>{
  if(!header){header=values.map(x=>x.replace(/^\uFEFF/,'').trim());if(new Set(header).size!==header.length)throw Error('csv_duplicate_header');return;}
  if(values.length===1&&!values[0])return;
  if(values.length!==header.length)throw Error('csv_row_width');
  if(++rows>1000000)throw Error('csv_row_limit');
  const record=Object.fromEntries(header.map((key,i)=>[key,values[i]]));
  for(const s of normalize(record,fullMeta))stations.set(s.id,s);
 };
 const resumeDeadline=Date.now()+26000;let resumed=false;
 for(let attempt=0;attempt<2;attempt++){try { while(true){
  const {done,value}=await reader.read();if(done)break;
  bytes+=value.length;if(bytes>180000000){await reader.cancel();throw Error('feed_size');}
  const part=decoder.decode(value,{stream:true});
  if(!parser){
   preamble+=part;
   const lines=preamble.split('\n');let offset=0,found=false;
   for(const line of lines.slice(0,-1)){
    if(line.includes('id_pdc_itinerance')||line.includes('Breitengrad')&&line.includes('Betreiber')){
     parser=new CsvParser(line.split(';').length>line.split(',').length?';':',');parser.write(preamble.slice(offset),emit);preamble='';found=true;break;
    }offset+=line.length+1;
   }
   if(!found&&preamble.length>64000)throw Error('csv_header_missing');
  }else parser.write(part,emit);
 }
 break;
 }catch(error){
  const timeout=error.name==='TimeoutError'||error.name==='AbortError';
  const validator=r.headers.get('etag')&&!r.headers.get('etag').startsWith('W/')?r.headers.get('etag'):r.headers.get('last-modified');
  if(timeout&&attempt===0&&bytes>0&&validator&&r.headers.get('accept-ranges')==='bytes'&&resumeDeadline-Date.now()>500){
   try {
    const continuation=await response(url,fetcher,allowed,{'range':'bytes='+bytes+'-','if-range':validator},Math.min(7000,resumeDeadline-Date.now()));
    const range=continuation.headers.get('content-range')||'';
    if(continuation.status===206&&range.startsWith('bytes '+bytes+'-')){
      reader=continuation.body.getReader();resumed=true;continue;
    }
    await continuation.body?.cancel();
   }catch{}
  }
  if(timeout&&stations.size){complete=false;issue='partial_download_timeout';break;}
  throw error;
 }}
 if(!parser)throw Error('csv_header_missing');
 if(complete)parser.write(decoder.decode(),emit);if(complete)parser.finish(emit);
 if(!stations.size)throw Error('feed_no_verified_ccs2');
 return {stations:[...stations.values()],source_updated_at:modified,source_url:url,rows,complete,issue,resumed};
}
const cache=new WeakMap();
async function cached(key,fetcher,run){
 let entries=cache.get(fetcher);if(!entries){entries=new Map();cache.set(fetcher,entries);}
 const old=entries.get(key);if(old?.expires>Date.now())return old.value;if(old?.pending)return old.pending;
 const pending=run().then(value=>{entries.set(key,{value,expires:Date.now()+6*3600000});return value;}).catch(e=>{entries.delete(key);throw e;});
 entries.set(key,{pending});return pending;
}
export function loadFrenchStations({fetcher=fetch,deadline=Date.now()+CATALOG_BUDGET_MS,includeAc=false}={}){
 return cached(includeAc?'FR_AC':'FR',fetcher,async()=>{
  fetcher=deadlineFetcher(fetcher,deadline);
  // This still-updated official transition feed has an explicit sunset.
  if(Date.now()>=Date.parse('2027-01-01T00:00:00Z'))throw Error('irve_transition_expired');
  const d=JSON.parse(await text(FR_META,fetcher,['www.data.gouv.fr']));
  if(!['fr-lo','lov2'].includes(d.license))throw Error('irve_license');
  const file=d.resources?.find(r=>r.format==='csv'&&r.schema?.version==='2.3.1'&&r.url?.startsWith('https://static.data.gouv.fr/'));
  if(!file||!date(file.last_modified)||Date.now()-Date.parse(file.last_modified)>30*86400000)throw Error('irve_resource_stale');
  return csv(file.url,fetcher,['static.data.gouv.fr'],(row,meta)=>normalizeIrve(row,meta,{includeAc}),{source:'FR_IRVE',source_updated_at:date(file.last_modified),license:d.license,attribution:'data.gouv.fr / producteurs IRVE, Licence Ouverte: '+FR_META});
 });
}
export function loadGermanStations({fetcher=fetch,deadline=Date.now()+CATALOG_BUDGET_MS,includeAc=false}={}){
 return cached(includeAc?'DE_AC':'DE',fetcher,async()=>{
  fetcher=deadlineFetcher(fetcher,deadline);
  const html=await text(DE_PAGE,fetcher,['www.bundesnetzagentur.de']);
  return csv(germanCsvLink(html),fetcher,['www.bundesnetzagentur.de','data.bundesnetzagentur.de'],(row,meta)=>normalizeBnetza(row,meta,{includeAc}),{source:'DE_BNETZA',license:'CC-BY-4.0',attribution:'bundesnetzagentur.de, Ladesäulenregister, CC BY 4.0'});
 });
}
export async function loadEuropeanStations({fetcher=fetch,deadline=Date.now()+CATALOG_BUDGET_MS,includeAc=false}={}){
 const result=await Promise.allSettled([loadSwissStations({fetcher,deadline,includeAc}),loadFrenchStations({fetcher,deadline,includeAc}),loadGermanStations({fetcher,deadline,includeAc}),loadItalianStations({fetcher,deadline,includeAc})]);
 const stations=[],sources=[];
 result.forEach((r,i)=>{const country=['CH','FR','DE','IT'][i];if(r.status==='fulfilled'){stations.push(...r.value.stations);sources.push({country,status:'ok',source_url:r.value.source_url,source_updated_at:r.value.source_updated_at,station_count:r.value.stations.length,download_complete:r.value.complete!==false,resumed:r.value.resumed||false,issue:r.value.issue||null,attribution:r.value.attribution||r.value.stations[0]?.attribution,...(r.value.municipality_ids?{municipality_ids:r.value.municipality_ids,municipalities_loaded:r.value.municipalities_loaded,municipality_sources:r.value.municipality_sources??[]}:{})});}else sources.push({country,status:'unavailable',reason:/^(?:feed_|csv_|german_|irve_|national_)[a-z0-9_]+$/.test(r.reason?.message)?r.reason.message:r.reason?.name==='TimeoutError'?'feed_timeout':r.reason?.name==='TypeError'?'feed_network_or_encoding':'feed_network_or_schema'});});
 // An empty partial catalog still carries per-source failures and preserves the road route.
 return {stations,sources,countries:sources.filter(s=>s.status==='ok').map(s=>s.country).sort(),coverage_complete:false,attribution:sources.filter(s=>s.status==='ok').map(s=>s.attribution).join('; '),source_url:'multiple official national sources'};
}

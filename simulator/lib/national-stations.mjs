import { deadlineFetcher, CATALOG_BUDGET_MS } from './request-deadline.mjs';
// Swiss Federal Office of Energy, ich-tanke-strom.ch, OICP static JSON.
// Non-commercial reuse with attribution; commercial reuse needs owner permission.
export const SFOE_SOURCE='https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/ch.bfe.ladestellen-elektromobilitaet.json';
export const SFOE_ATTRIBUTION='Swiss Federal Office of Energy (SFOE), ich-tanke-strom.ch: https://opendata.swiss/dataset/ladestationen-fuer-elektroautos/';
const caches=new WeakMap(),acCaches=new WeakMap();
const clean=x=>typeof x==='string'?x.replace(/[\x00-\x1f<>]/g,' ').slice(0,200):'';
export function normalizeSfoe(data,{updatedAt=null,fetchedAt=new Date().toISOString(),includeAc=false}={}) {
  if(!Array.isArray(data?.EVSEData))throw Error('national_station_schema');
  const stations=new Map();
  for(const operator of data.EVSEData) {
    if(!Array.isArray(operator.EVSEDataRecord))throw Error('national_station_schema');
    for(const r of operator.EVSEDataRecord) {
      if(!r||typeof r!=='object')continue;
      if(!Array.isArray(r.Plugs))continue;
      const dc=r.Plugs.some(p=>/^CCS Combo 2 Plug(?: \(Cable Attached\))?$/.test(p));
      const ac=includeAc&&!dc&&r.Plugs.some(p=>/^Type 2 (?:Outlet|Socket \(Outlet\)|Plug \(Cable Attached\))$/.test(p));
      if(!dc&&!ac)continue;
      if(!['Publicly accessible','Free publicly accessible','Paying publicly accessible'].includes(r.Accessibility))continue;
      const parts=String(r.GeoCoordinates?.Google||'').trim().split(/\s+/);
      const [lat,lon]=parts.map(Number);
      if(parts.length!==2||!Number.isFinite(lat)||!Number.isFinite(lon)||lat<45||lat>48.5||lon<5||lon>11.5||typeof r.EvseID!=='string')continue;
      const powers=(Array.isArray(r.ChargingFacilities)?r.ChargingFacilities:[]).filter(f=>dc?f.powertype==='DC':['AC_1_PHASE','AC_3_PHASE','AC_1_phase','AC_3_phase'].includes(f.powertype)).map(f=>Number(f.power)).filter(p=>Number.isFinite(p)&&p>0&&p<=1000);
      stations.set(r.EvseID,{id:r.EvseID,lat,lon,country:'CH',name:clean((Array.isArray(r.ChargingStationNames)?r.ChargingStationNames.find(n=>n?.lang==='en')?.value:typeof r.ChargingStationNames==='string'?r.ChargingStationNames:null)||r.Address?.Street),
        operator:clean(operator.OperatorName),ccs2:dc,connectorType:dc?'CCS2':'AC',power_kw:powers.length?Math.max(...powers):null,
        availability:'unknown',availability_updated_at:null,source:'SFOE_ICH_TANKE_STROM',source_url:SFOE_SOURCE,
        source_updated_at:updatedAt,fetched_at:fetchedAt,record_updated_at:null,tariff:null,
        access:clean(r.Accessibility),motorway_access:r.AccessibilityLocation==='OnHighway'?'reported':'unknown'});
    }
  }
  return [...stations.values()];
}
export async function loadSwissStations({fetcher=fetch,now=Date.now(),deadline=Date.now()+CATALOG_BUDGET_MS,includeAc=false}={}) {
  const cache=includeAc?acCaches:caches;
  const old=cache.get(fetcher);
  if(old?.value&&old.expires>now)return structuredClone(old.value);
  if(old?.pending)return structuredClone(await old.pending);
  const pending=(async()=>{
    const response=await deadlineFetcher(fetcher,deadline)(SFOE_SOURCE,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'user-agent':'TeslaVoiceMCP/1.0'}});
    if(!response.ok)throw Error('national_station_http_'+response.status);
    const reader=response.body.getReader();const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64000000){await reader.cancel();throw Error('national_station_size');}chunks.push(value);}
    const modified=response.headers.get('last-modified');
    const updatedAt=modified&&Number.isFinite(Date.parse(modified))?new Date(modified).toISOString():null;
    const stations=normalizeSfoe(JSON.parse(Buffer.concat(chunks).toString()),{updatedAt,fetchedAt:new Date(now).toISOString(),includeAc});
    if(!stations.length)throw Error('national_station_empty');
    const value={stations,countries:['CH'],attribution:SFOE_ATTRIBUTION,source_url:SFOE_SOURCE,source_updated_at:updatedAt,availability_verified:false};
    cache.set(fetcher,{value,expires:now+900000});
    return value;
  })();
  cache.set(fetcher,{pending});
  try{return structuredClone(await pending);}catch(e){cache.delete(fetcher);throw e;}
}

import { matchesPublicOrigin } from './public-origin.mjs';
import {TESLA_P256_ORIGIN} from './partner-p256-identity.mjs';
import {hash,seal,unseal} from './security.mjs';
export const NATIVE_COORDINATE_SCHEMA='experimental-field90-coordinate-string-python-14912c8';
export const NATIVE_SC_SCHEMA='experimental-field22-id1-replace0-teslemetry-2c45a2f9';
export function nativeNavigationEnabled(config,kind){
 const e=config.env??{};
 return matchesPublicOrigin(config.origin,e)&&e.VERCEL_ENV==='production'&&e.TESLA_FLEET_REGION==='eu'&&
  ['TESLA_BACKEND_ENABLED','TESLA_READ_ENABLED','TESLA_COMMANDS_ENABLED','TESLA_COMMAND_EXECUTION_ENABLED','TESLA_REAL_RELEASE_APPROVED'].every(k=>e[k]==='true')&&
  (kind==='coordinates'?e.TESLA_NATIVE_COORDINATE_PILOT_ENABLED==='true'&&e.TESLA_NATIVE_COORDINATE_ENABLED==='true'&&e.TESLA_NATIVE_COORDINATE_SCHEMA===NATIVE_COORDINATE_SCHEMA:
   kind==='supercharger'&&e.TESLA_NATIVE_SUPERCHARGER_ENABLED==='true'&&e.TESLA_NATIVE_SUPERCHARGER_SCHEMA===NATIVE_SC_SCHEMA||
   kind==='waypoints'&&e.TESLA_NATIVE_WAYPOINTS_ENABLED==='true');
}
const decimal=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/;
export function parseNativeCoordinates(value){
 if(typeof value!=='string'||value.length>2048)throw Error('invalid_arguments');
 const rows=value.split(';');if(rows.length<2||rows.length>16)throw Error('invalid_arguments');
 return rows.map(row=>{const p=row.split(',');if(p.length!==2||p.some(v=>!decimal.test(v)))throw Error('invalid_arguments');
  const [lat,lon]=p.map(Number);if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180)throw Error('invalid_arguments');return {lat,lon};});
}
export const validTeslaSiteID=id=>typeof id==='string'&&/^[1-9][0-9]{0,18}$/.test(id)&&BigInt(id)<=9223372036854775807n;
// Provenance comes from an explicit, authenticated Tesla nearby-sites reading,
// never from a caller-provided operator label, public catalog or guessed ID.
export function nativeStationSelections({config,store,now=Date.now}){
 const key=subject=>'native-sc-selection:'+hash(config.issuer+'\n'+subject+'\n'+config.env.TESLA_VEHICLE_VIN);
 return {async remember(subject,sites){
  const selected=sites.filter(s=>s.kind==='supercharger'&&validTeslaSiteID(s.tesla_site_id)&&s.tesla_site_id_source==='TESLA_NEARBY_CHARGING_SITES'&&typeof s.name==='string'&&s.name&&Number.isFinite(s.latitude)&&Number.isFinite(s.longitude)).slice(0,20)
   .map(s=>({id:s.tesla_site_id,name:s.name,lat:s.latitude,lon:s.longitude}));
  const k=key(subject);await store.put(k,seal({source:'TESLA_NEARBY_CHARGING_SITES',expires:now()+900000,sites:selected},config.key,k),900);
  return selected.length;
 },async require(subject,id){
  if(!validTeslaSiteID(id))throw Error('invalid_arguments');
  const k=key(subject),raw=await store.get(k);if(!raw)throw Error('native_station_selection_required');
  let data;try{data=unseal(raw,config.key,k);}catch{throw Error('store');}
  if(data?.source!=='TESLA_NEARBY_CHARGING_SITES'||!Number.isFinite(data.expires)||data.expires<=now()||!Array.isArray(data.sites))throw Error('native_station_selection_required');
  const station=data.sites.find(s=>s.id===id);if(!station)throw Error('native_station_selection_required');return station;
 }};
}

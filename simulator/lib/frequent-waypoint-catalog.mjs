import {readFileSync} from 'node:fs';

// Operators can configure their own catalog privately without editing a tracked file.
export function parseFrequentDestinationCatalog(raw) {
 if (typeof raw !== 'string' || raw.length > 100000) throw Error('invalid_frequent_destinations_configuration');
 let entries; try { entries=JSON.parse(raw); } catch { throw Error('invalid_frequent_destinations_configuration'); }
 if (!Array.isArray(entries) || entries.length > 100 || entries.some(item =>
   !item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' ||
   !item.name.trim() || item.name.length > 200 || !Array.isArray(item.aliases) || item.aliases.length > 20 ||
   item.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 200)))
  throw Error('invalid_frequent_destinations_configuration');
 return entries;
}
const configuredCatalog=process.env.FREQUENT_DESTINATIONS_JSON;
const catalogRaw=typeof configuredCatalog==='string' && configuredCatalog.trim() ? configuredCatalog : readFileSync(new URL('../config/frequent-destinations.json',import.meta.url),'utf8');
export const frequentDestinationCatalog=parseFrequentDestinationCatalog(catalogRaw);
const placeIdPattern=/^[A-Za-z0-9_-]{8,128}$/;

export function verifiedFrequentPlaceIds(catalog=frequentDestinationCatalog){
 return [...new Set(catalog.filter(isVerifiedPlaceRecord).map(d=>d.placeId))];
}

export function isVerifiedPlaceRecord(destination){
 if(!destination||destination.placeIdVerified!==true||typeof destination.placeId!=='string'||!placeIdPattern.test(destination.placeId)||typeof destination.placeIdSource!=='string')return false;
 try{return new URL(destination.placeIdSource).protocol==='https:';}catch{return false;}
}

export function parseRefIdWaypointList(value){
 if(typeof value!=='string'||value.length>2048)return null;
 const entries=value.split(',');
 if(entries.length<2||entries.length>16)return null;
 const ids=[];
 for(const entry of entries){
  const match=/^refId:([A-Za-z0-9_-]{8,128})$/.exec(entry);
  if(!match)return null;
  ids.push(match[1]);
 }
 return ids;
}

export function isVerifiedRefIdWaypointList(value,{catalog=frequentDestinationCatalog,verifiedWaypointPlaceIds}={}){
 const ids=parseRefIdWaypointList(value);
 if(!ids)return false;
 const allowed=new Set(verifiedWaypointPlaceIds??verifiedFrequentPlaceIds(catalog));
 return ids.every(id=>allowed.has(id));
}

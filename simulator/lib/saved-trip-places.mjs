import {hash,seal,unseal} from './security.mjs';

// Private, user-confirmed aliases; Tesla in-car favorites are a separate store.
export const savedPlaceAlias=query=>{
 if(typeof query!=='string')return null;
 const s=query.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[.!?]+$/,'').trim().replace(/\s+/g,' ');
 if(['casa','a casa','casa mia','la mia casa','home'].includes(s))return 'home';
 if(['lavoro','al lavoro','a lavoro','il mio lavoro','ufficio','in ufficio','work'].includes(s))return 'work';
 return null;
};
const coords={type:'object',properties:{lat:{type:'number',minimum:-90,maximum:90},lon:{type:'number',minimum:-180,maximum:180}},required:['lat','lon'],additionalProperties:false};
const googleRef={type:'object',properties:{placeId:{type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'}},required:['placeId'],additionalProperties:false};
const bothRefs={type:'object',properties:{coordinates:coords,placeId:{type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'}},required:['coordinates','placeId'],additionalProperties:false};
const securitySchemes=[{type:'oauth2',scopes:['location:read']}];
export const savedTripPlaceTools=[
 {name:'get_saved_trip_places',description:'Reads Home and Work places explicitly saved in this account’s connector and reports whether OSM planner coordinates, a Google multipoint Place ID, or both are available. Does not read Tesla favorites, GPS, or maps, and does not send destinations. Missing aliases must be configured by the user, not searched on public maps.',inputSchema:{type:'object',properties:{},additionalProperties:false},securitySchemes,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},
 {name:'set_saved_trip_place',description:'Saves or deletes Home/Work only after an explicit request and user confirmation. Accepts exact confirmed coordinates, a Place ID resolved and verified by Google Places for this account, or both as {coordinates:{lat,lon},placeId} when the user confirms they identify the same place. Saving one reference removes the other to avoid stale data. Does not derive aliases from GPS or Tesla favorites. point=null deletes only the selected alias. Sends no Tesla command and does not require a Tesla connection.',inputSchema:{type:'object',properties:{alias:{type:'string',enum:['home','work']},point:{anyOf:[coords,googleRef,bothRefs,{type:'null'}]},confirmedByUser:{type:'boolean',const:true}},required:['alias','point','confirmedByUser'],additionalProperties:false},securitySchemes,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
];
const validCoords=p=>p&&Object.getPrototypeOf(p)===Object.prototype&&Object.keys(p).length===2&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lon)&&Math.abs(p.lon)<=180;
const validGoogleRef=p=>p&&Object.getPrototypeOf(p)===Object.prototype&&Object.keys(p).length===1&&typeof p.placeId==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(p.placeId);
const validBothRefs=p=>p&&Object.getPrototypeOf(p)===Object.prototype&&Object.keys(p).length===2&&validCoords(p.coordinates)&&typeof p.placeId==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(p.placeId);
const valid=p=>validCoords(p)||validGoogleRef(p)||validBothRefs(p);
export function savedTripPlaces({config,store,now=Date.now,verifyGooglePlaceIds}){
 const key=subject=>'saved-trip-places:'+hash(config.issuer+'\n'+subject);
 const get=async subject=>{
  const k=key(subject),raw=await store.get(k);
  if(!raw)return {source:'USER_CONFIRMED_ACCOUNT',places:{},google_place_ids:{},updated_at:null,tesla_read_performed:false};
  try{
   const record=unseal(raw,config.key,k);
   if(!record||!record.places||Object.getPrototypeOf(record.places)!==Object.prototype||
      Object.keys(record.places).some(n=>!['home','work'].includes(n)||!validCoords(record.places[n])&&!validGoogleRef(record.places[n]))||
      record.google_place_ids!==undefined&&(!record.google_place_ids||Object.getPrototypeOf(record.google_place_ids)!==Object.prototype||
       Object.keys(record.google_place_ids).some(n=>!['home','work'].includes(n)||typeof record.google_place_ids[n]!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(record.google_place_ids[n])))||
      !Number.isFinite(Date.parse(record.updated_at)))throw Error();
   const places={},google_place_ids={...(record.google_place_ids??{})};
   for(const alias of ['home','work']){
    const saved=record.places[alias];
    if(validCoords(saved))places[alias]=saved;
    else if(validGoogleRef(saved))google_place_ids[alias]??=saved.placeId;
   }
   for(const alias of ['home','work'])if(!places[alias]&&google_place_ids[alias])places[alias]={placeId:google_place_ids[alias]};
   return {...record,places,google_place_ids,source:'USER_CONFIRMED_ACCOUNT',tesla_read_performed:false};
  }catch{throw Error('store');}
 };
 return {get,async set(subject,args){
  if(!args||Object.getPrototypeOf(args)!==Object.prototype||
     Object.keys(args).some(k=>!['alias','point','confirmedByUser'].includes(k))||
     !['home','work'].includes(args.alias)||args.confirmedByUser!==true||
     args.point!==null&&!valid(args.point))throw Error('invalid_arguments');
  // A bare user-supplied Place ID is not trusted. Require this account's
  // unexpired Google API proof before saving it as a durable alias.
  const placeId=validGoogleRef(args.point)?args.point.placeId:validBothRefs(args.point)?args.point.placeId:null;
  if(placeId){
   if(typeof verifyGooglePlaceIds!=='function')throw Error('place_id_unverified');
   const verified=await verifyGooglePlaceIds(subject,[placeId]);
   if(!verified.includes(placeId))throw Error('place_id_unverified');
  }
  const k=key(subject),lock=await store.lock(k);
  try{
   const previous=await get(subject);
   const places={...previous.places},google_place_ids={...previous.google_place_ids};
   if(args.point===null){delete places[args.alias];delete google_place_ids[args.alias];}
   else if(validBothRefs(args.point)){
    places[args.alias]={lat:args.point.coordinates.lat,lon:args.point.coordinates.lon};
    google_place_ids[args.alias]=args.point.placeId;
   }else if(validGoogleRef(args.point)){
    delete places[args.alias];google_place_ids[args.alias]=args.point.placeId;
   }else{
    places[args.alias]={lat:args.point.lat,lon:args.point.lon};delete google_place_ids[args.alias];
   }
   const record={places,google_place_ids,updated_at:new Date(now()).toISOString()};
   await lock.savePermanent(seal(record,config.key,k));
   return {saved:args.point!==null,alias:args.alias,reference_type:args.point===null?null:validBothRefs(args.point)?'user_confirmed_coordinates_and_google_place_id':validGoogleRef(args.point)?'user_confirmed_google_place_id':'user_confirmed_coordinates',source:'USER_CONFIRMED_ACCOUNT',updated_at:record.updated_at,tesla_read_performed:false};
  }finally{await lock.release().catch(()=>{});}
 }};
}

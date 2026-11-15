import {frequentDestinationCatalog,isVerifiedPlaceRecord} from './frequent-waypoint-catalog.mjs';
const normalize=s=>s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/\s+/g,' ');

export const frequentWaypointsTool={
 name:'resolve_frequent_waypoints',
 description:'Prepares, but does not send, one navigation_waypoints_request using the native refId:<verified Place ID> format, comma-separated, for 2–16 destinations in the requested order. Uses only Place IDs verified in the local catalog. If the feature gate is off, a name is missing, or an ID is unverified, returns no payload and does not fall back to coordinates. Shows the payload and waits for user authorization before any dispatch.',
 inputSchema:{type:'object',additionalProperties:false,required:['destinations'],properties:{destinations:{type:'array',minItems:2,maxItems:16,items:{type:'string',minLength:1,maxLength:200}}}},
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes:[{type:'oauth2',scopes:['location:read']}]
};

export function resolveFrequentWaypoints(names,{nativeWaypointsEnabled=false,catalog=frequentDestinationCatalog}={}){
 if(!Array.isArray(names)||names.length<2||names.length>16||names.some(s=>typeof s!=='string'||!s.trim()||s.length>200))throw Error('invalid_arguments');
 const resolved=names.map(name=>catalog.find(d=>[d.name,...d.aliases].some(alias=>normalize(alias)===normalize(name)))??null);
 const missing=names.filter((_,i)=>!resolved[i]);
 if(missing.length)return {status:'destination_not_found',missing,command_request:null,sent_to_vehicle:false};
 if(!nativeWaypointsEnabled)return {status:'native_waypoints_disabled',command_request:null,sent_to_vehicle:false};
 if(nativeWaypointsEnabled){
  const missingPlaceIds=resolved.filter(d=>!isVerifiedPlaceRecord(d)).map(d=>d.name);
  if(missingPlaceIds.length)return {status:'place_id_unverified',missing:missingPlaceIds,command_request:null,sent_to_vehicle:false};
 }
 const waypoints=resolved.map(d=>'refId:'+d.placeId).join(',');
 if(waypoints.length>2048)throw Error('invalid_arguments');
 return {status:'payload_prepared',format:'refId',
  destinations:resolved.map(({name,placeId,placeIdSource})=>({name,placeId,placeIdSource})),
  command_request:{operation:'navigation_waypoints_request',arguments:{waypoints}},sent_to_vehicle:false,dispatch_performed:false,
  note:'Native payload prepared but not sent. Verify stop order and acceptance on the vehicle display.'};
}

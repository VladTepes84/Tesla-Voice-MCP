import { hash, random, seal, unseal } from './security.mjs';
import { gpsRouteCandidateEnabled,GPS_ROUTE_ORDER_SCHEMA } from './gps-route-activation.mjs';
import {nativeNavigationEnabled,parseNativeCoordinates} from './native-navigation-candidates.mjs';
import {resolveFrequentWaypoints} from './frequent-waypoints.mjs';

// Data preparation only. Never geocode, read Tesla, dispatch, truncate or
// reorder. The saved destinations already include required DC stops/return.
export function tripRouteHandoff(saved,{candidateEnabled=false,nativeBatchEnabled=false}={}){
 const blocked=reason=>({available:false,reason,command_request:null,automatic_dispatch:false});
 if(candidateEnabled!==true&&nativeBatchEnabled!==true)return blocked('gps_route_candidate_disabled');
 const destinations=saved?.destinations,itinerary=saved?.itinerary,plan=itinerary?.charging_plan;
 if(plan?.feasible!==true)return blocked('energy_not_verified');
 if(!Array.isArray(destinations)||destinations.length<2||destinations.length>16)return blocked('route_requires_2_to_16_destinations');
 if(destinations.some(p=>!p||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||!Number.isFinite(p.lon)||Math.abs(p.lon)>180))return blocked('destination_not_available');
 if(!Array.isArray(plan.stops)||plan.stops.some((s,i)=>!s||s.connectorType==='AC'||s.ccs2!==true&&s.connectorType!=='CCS2'||
    !Number.isInteger(s.after_leg)||s.after_leg<0||s.after_leg>=destinations.length-1||i>0&&s.after_leg<=plan.stops[i-1].after_leg||
    s.lat!==destinations[s.after_leg].lat||s.lon!==destinations[s.after_leg].lon))return blocked('dc_stops_not_verified');
 const reserve=plan.policy?.reserve_percent,capacity=itinerary.energy?.inputs?.usableCapacityKwh,legs=itinerary.legs;
 if(!Number.isFinite(reserve)||reserve<15||reserve>100||!Number.isFinite(capacity)||capacity<1||capacity>250||itinerary.energy?.inputs?.reservePercent!==reserve||
    !Array.isArray(legs)||legs.length!==destinations.length||
    legs.some(l=>l?.reserve_met!==true||!Number.isFinite(l.arrival_kwh)||l.arrival_kwh<Math.ceil(capacity*reserve/50)/2))return blocked('leg_reserve_not_verified');
 const points=destinations.map(({lat,lon})=>({lat,lon}));
 const waypoints=points.map(p=>String(p.lat)+','+String(p.lon)).join(';');
 if(nativeBatchEnabled){try{parseNativeCoordinates(waypoints);}catch{return blocked('native_coordinate_format_not_verified');}}
 return {available:true,command_request:nativeBatchEnabled?{operation:'navigation_waypoints_request',arguments:{waypoints}}:{operation:'navigation_gps_request',arguments:{points}},api_actuation_count:nativeBatchEnabled?1:points.length,
  via_existing_tool:'execute_requested_vehicle_command',requires_explicit_user_request:true,automatic_dispatch:false,
  experimental:true,atomic:false,vehicle_route_verified:false,battery_preconditioning_verified:false,
  energy_verification_basis:'SAVED_PLAN_NOT_CURRENT_VEHICLE',plan_created_at:saved.created_at,
  requires_replanning_if_conditions_changed:true,reserve_percent:reserve};
}

// Navigation-only routes need no charging plan; smart road-trip routes keep their
// existing energy/reserve checks. Both preserve their exact destination order.
// A navigation-only route is deliberately independent of charging/SOC planning.
// Each coordinate must retain an OSM element source or a privately saved home.
function naturalNavigationBase(saved){
 const blocked=reason=>({available:false,reason,command_request:null,automatic_dispatch:false,single_destination_fallback_allowed:false});
 const destinations=saved?.destinations,evidence=saved?.place_evidence;
 if(saved?.navigation_only!==true)return blocked('navigation_only_route_required');
 if(!Array.isArray(destinations)||destinations.length<2||destinations.length>4)return blocked('route_requires_2_to_4_destinations');
 if(destinations.some(p=>!p||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||!Number.isFinite(p.lon)||Math.abs(p.lon)>180))return blocked('destination_not_available');
 if(!Array.isArray(evidence)||evidence.length!==destinations.length)return blocked('destination_evidence_missing');
 const trusted=evidence.every(e=>{
  if(e?.source==='USER_CONFIRMED_ACCOUNT')return e.coordinate_status==='user_confirmed_account';
  if(!['PHOTON_OSM','NOMINATIM_OSM','OSM_PUBLIC_MAP'].includes(e?.source))return false;
  if(!['unique_public_map_match_not_user_confirmed','user_selected_map_candidate_not_exact_coordinate_confirmation'].includes(e.coordinate_status))return false;
  if(!Number.isSafeInteger(e.osm_id)||e.osm_id<1||!['node','way','relation'].includes(String(e.osm_type).toLowerCase()))return false;
  return typeof e.source_url==='string'&&/^https:\/\/www\.openstreetmap\.org\/(?:node|way|relation)\/[1-9][0-9]*$/.test(e.source_url);
 });
 if(!trusted)return blocked('destination_coordinates_not_verified_from_osm_or_saved_place');
 return {available:true,points:destinations.map(({lat,lon})=>({lat,lon})),command_request:null,
  automatic_dispatch:false,requires_explicit_user_request:true,single_destination_fallback_allowed:false,
  experimental:true,atomic:false,vehicle_route_verified:false,battery_preconditioning_verified:false,
  energy_verification_basis:'NOT_REQUESTED'};
}

function verifiedRefIdRouteHandoff(saved,{nativeWaypointsEnabled=false}={}){
 const blocked=reason=>({available:false,reason,command_request:null,automatic_dispatch:false,single_destination_fallback_allowed:false});
 const validated=saved?.navigation_only===true?naturalNavigationBase(saved):tripRouteHandoff(saved,{candidateEnabled:true,nativeBatchEnabled:false});
 if(!validated.available)return validated;
 const route=saved?.resolved_route??saved?.requested_route;
 if(!route||typeof route.destination!=='string'||!Array.isArray(route.stops??[]))return blocked('verified_refid_route_names_required');
 const names=[...(route.stops??[]),route.destination];
 if(route.roundTrip===true){if(typeof route.origin!=='string')return blocked('return_origin_refid_unavailable');names.push(route.origin);}
 if(names.length!==saved.destinations.length)return blocked('planned_destinations_do_not_match_requested_waypoints');
 const resolved=resolveFrequentWaypoints(names,{nativeWaypointsEnabled});
 if(resolved.status!=='payload_prepared')return blocked(resolved.status);
 return {...validated,command_request:resolved.command_request,api_actuation_count:1,
  transport:'experimental_native_refid_waypoints',resolved_destinations:resolved.destinations,
  vehicle_route_verified:false,battery_preconditioning_verified:false};
}
// Arbitrary OSM locations use the separate GPS gate: one MCP invocation expands
// into several ordered HMAC actions, so the candidate is non-atomic/unverified.
function naturalMultipointHandoff(saved,config){
 const refIds=verifiedRefIdRouteHandoff(saved,{nativeWaypointsEnabled:config.env?nativeNavigationEnabled(config,'waypoints'):false});
 if(refIds.available)return refIds;
 if(saved?.navigation_only===true){
  const base=naturalNavigationBase(saved);
  if(!base.available)return base;
  if(config.env&&gpsRouteCandidateEnabled(config))return {...base,
   command_request:{operation:'navigation_gps_request',arguments:{points:base.points}},
   api_actuation_count:base.points.length,transport:'experimental_gps_multi_send',
   order_schema:GPS_ROUTE_ORDER_SCHEMA};
  return {...base,available:false,reason:'gps_route_candidate_disabled',refid_status:refIds.reason??null};
 }
 if(config.env&&gpsRouteCandidateEnabled(config)){
  const gps=tripRouteHandoff(saved,{candidateEnabled:true,nativeBatchEnabled:false});
  if(gps.available)return {...gps,transport:'experimental_gps_multi_send',order_schema:GPS_ROUTE_ORDER_SCHEMA};
 }
 return refIds;
}

// Prepare data for the already validated single-destination command, never send it.
export function tripDestinationHandoff(destinations,index=0){
 if(!Number.isInteger(index)||index<0||index>30)throw Error('invalid_arguments');
 const point=destinations?.[index];
 if(!point||!Number.isFinite(point.lat)||Math.abs(point.lat)>90||!Number.isFinite(point.lon)||Math.abs(point.lon)>180)
  return {available:false,reason:'destination_not_available',selected_index:index,command_request:null};
 return {available:true,selected_index:index,destination:{lat:point.lat,lon:point.lon},
  command_request:{operation:'navigation_request',arguments:{destination:String(point.lat)+', '+String(point.lon)}},
  via_existing_tool:'execute_requested_vehicle_command',requires_explicit_user_request:true,
  automatic_dispatch:false,position_verified:false,arrival_at_previous_stop_verified:false};
}

// An itinerary can expire; an uncertain vehicle command cannot.
export function tripNavigation({ store, config, now = Date.now }) {
  const key = (subject, id) => 'planned-trip:' + hash(config.issuer + '\n' + subject + '\n' + id);
  const draftKey = (subject, id) => 'planned-trip-draft:' + hash(config.issuer + '\n' + subject + '\n' + id);
  const getDraft = async (subject, id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw Error('invalid_arguments');
    const k=draftKey(subject,id),raw=await store.get(k);
    if(!raw)return {available:false,reason:'draft_not_found_or_expired'};
    try {
      const saved=unseal(raw,config.key,k);
      if(saved?.id!==id||!Number.isFinite(Date.parse(saved.expires_at))||Date.parse(saved.expires_at)<=now())return {available:false,reason:'draft_not_found_or_expired'};
      return {available:true,...saved};
    } catch { throw Error('store'); }
  };
  const get = async (subject, id, {destinationIndex=0}={}) => {
    if(!Number.isInteger(destinationIndex)||destinationIndex<0||destinationIndex>30)throw Error('invalid_arguments');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw Error('invalid_arguments');
    const k = key(subject, id), raw = await store.get(k);
    if (!raw) return { available: false, reason: 'not_found_or_expired' };
    const saved = unseal(raw, config.key, k);
    if (Date.parse(saved.expires_at) <= now()) return { available: false, reason: 'not_found_or_expired' };
    const hasAcStops=saved.itinerary?.charging_plan?.stops?.some(s=>s.connectorType==='AC'&&s.ccs2!==true);
    const multiStop=Array.isArray(saved.destinations)&&saved.destinations.length>1;
    const requiresVerifiedWaypointIdentity=multiStop&&saved.requires_verified_waypoint_identity===true;
    const routeHandoff=requiresVerifiedWaypointIdentity
      ?naturalMultipointHandoff(saved,config)
      :tripRouteHandoff(saved,{candidateEnabled:config.env?gpsRouteCandidateEnabled(config):false,nativeBatchEnabled:nativeNavigationEnabled(config,'coordinates')});
    const navigationHandoff=multiStop?{available:false,reason:'multi_stop_requires_verified_waypoints',command_request:null,automatic_dispatch:false,single_destination_fallback_allowed:false}:
      hasAcStops?{available:false,reason:'ac_stops_not_allowed_for_road_trip',command_request:null}:
      saved.itinerary?.charging_plan?.feasible===true?{...tripDestinationHandoff(saved.destinations,destinationIndex),energy_verification_basis:'SAVED_PLAN_NOT_CURRENT_VEHICLE',plan_created_at:saved.created_at,requires_replanning_if_conditions_changed:true}:{available:false,reason:'energy_not_verified',command_request:null};
    return { available: true, ...saved, multi_stop_navigation_handoff:routeHandoff, navigation_handoff:navigationHandoff,
      sent_to_vehicle: false, multi_stop_transport_supported:routeHandoff.available,multi_stop_vehicle_verified:false,
      requires_explicit_request_per_destination:multiStop?false:!routeHandoff.available,
      multi_stop_requires_verified_waypoints:multiStop, single_destination_fallback_allowed:!multiStop,
      iphone_app_sync: 'not_verifiable' };
  };
  return { get, getDraft, async saveDraft(subject, draft) {
    if(typeof subject!=='string'||!subject||!draft||Object.getPrototypeOf(draft)!==Object.prototype)throw Error('invalid_arguments');
    const id=random(),k=draftKey(subject,id),created_at=new Date(now()).toISOString(),expires_at=new Date(now()+900000).toISOString();
    await store.put(k,seal({id,...draft,created_at,expires_at},config.key,k),900);
    return {id,created_at,expires_at,retrieval_tool:'plan_smart_trip',automatic_dispatch:false};
  }, async save(subject, plan) {
    const id = random(), k = key(subject, id), expires_at = new Date(now() + 86400000).toISOString();
    const record={ ...plan, created_at: new Date(now()).toISOString(), expires_at };
    await store.put(k, seal(record, config.key, k), 86400);
    const requiresVerifiedWaypointIdentity=Array.isArray(plan.destinations)&&plan.destinations.length>1&&plan.requires_verified_waypoint_identity===true;
    const whole=requiresVerifiedWaypointIdentity?naturalMultipointHandoff(record,config):tripRouteHandoff(record,{candidateEnabled:config.env?gpsRouteCandidateEnabled(config):false,nativeBatchEnabled:nativeNavigationEnabled(config,'coordinates')});
    return { id, expires_at, retrieval_tool: 'get_planned_trip', automatic_dispatch: false,
      multi_stop_candidate_available:whole.available,
      ...(whole.available?{}:{multi_stop_block_reason:whole.reason}) };
  } };
}

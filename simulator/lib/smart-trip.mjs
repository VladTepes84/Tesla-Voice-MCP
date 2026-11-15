import { tripDestinationHandoff } from './trip-navigation.mjs';
import { planChargingRoadTrip } from './charging-route.mjs';
import { PLANNER_BUDGET_MS } from './request-deadline.mjs';
import { invokeRoadTrip, roadTripTools } from './road-trip.mjs';
import { normalizeSpeechDestinationQuery, resolveDestinationCandidates } from './destination-resolution.mjs';
import { savedPlaceAlias } from './saved-trip-places.mjs';

const point = roadTripTools.find(tool => tool.name === 'plan_road_trip').inputSchema.properties.origin;
const place = { anyOf: [{ type: 'string', minLength: 2, maxLength: 200 }, point] };
export const smartTripTool = {
  name: 'plan_smart_trip',
  description: 'Plans Tesla road trips and itineraries. For a navigation-only request with 2–4 named destinations, set navigationOnly=true; when Google Places is enabled in Production, it resolves Google Place IDs first without reading GPS or battery and without sending commands. Otherwise it uses Photon/OSM with Nominatim fallback. Resolve ambiguous Google results with resolve_waypoint_places and selectedPlaceId. Home and Work require private saved aliases; Tesla favorites are not imported. Planning saves the route, while dispatch is separate and requires GPS or verified Place ID gates. Use Tesla as origin only with explicit GPS consent; retrieve state of charge and saved preferences only with the required consent. Reuses identical searches and stores requested names and result provenance in an encrypted draft. If a place is ambiguous, present one grouped choice and preserve the itinerary for 15 minutes; continue with continuationId and placeSelections or placeCorrections without asking for the other stops again. If no reliable result exists, say so without asking the user to repeat the whole trip; optional corrections change only one stop. Resolve Home only from a confirmed private account place, never from public maps. Do not reduce a multi-stop itinerary to navigation_request for one stop; if multipoint cannot be verified, return the block and preserve order. Map coordinates are OSM candidates, not Google Place IDs or user-confirmed coordinates. OSRM may receive requested motorway/toll exclusions only if supported by its profile; if rejected, do not use an unrestricted fallback route. Preferred road names are not applied and no route preference is sent to Tesla navigation. For trips with charging, reuse saved chargingMapsConsent or request explicit consent; navigation-only planning uses its own consent. Unknown prices and availability remain unknown. Trip charging uses DC/HPC CCS2 only; search for AC only when separately requested. Encrypted plans are available through get_planned_trip for 24 hours. Does not send destinations or commands.',
  inputSchema: { type: 'object', additionalProperties: false, required: [],
    anyOf: [{ required: ['destination'] }, { required: ['continuationId'] }],
    properties: {
      destination: place, origin: place, stops: { type: 'array', items: place, maxItems: 8 },
      continuationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
      placeSelections: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        required: ['placeIndex','candidateIndex'], properties: { placeIndex: { type: 'integer', minimum: 0, maximum: 9 }, candidateIndex: { type: 'integer', minimum: 0, maximum: 9 } } } },
      placeCorrections: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        required: ['placeIndex','query'], properties: { placeIndex: { type: 'integer', minimum: 0, maximum: 9 }, query: { type: 'string', minLength: 2, maxLength: 200 } } } },
      roundTrip: { type: 'boolean' }, navigationOnly: { type: 'boolean' }, externalMapsConsent: { type: 'boolean', const: true },
      teslaLocationConsent: { type: 'boolean' }, teslaBatteryConsent: { type: 'boolean' },
      batteryMode: { type: 'string', enum: ['cached', 'live'] }, allowCachedFallback: { type: 'boolean' },
      batteryPercent: { type: 'number', minimum: 0, maximum: 100 }, simulatedBattery: { type: 'boolean' },
      routePreferences: { type: 'object', additionalProperties: false, properties: {
        avoidTolls: { type: 'boolean' }, avoidHighways: { type: 'boolean' }, avoidMotorways: { type: 'boolean' },
        preferredRoads: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 2, maxLength: 100 } }
      } },
      chargingRange: { type: 'object', additionalProperties: false, required: ['minimumPercent','maximumPercent'], properties: {
        minimumPercent: { type: 'number', minimum: 0, maximum: 100 }, maximumPercent: { type: 'number', minimum: 0, maximum: 100 }
      } },
      objective: { type: 'string', enum: ['balanced', 'energy', 'time', 'cost'] },
      reservePercent: { type: 'number', minimum: 15, maximum: 99 },
      allowAcCharging: {type:'boolean',const:false}
    } },
  securitySchemes: [{ type: 'oauth2', scopes: ['battery:read', 'location:read'] }],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
};

const maxSampleAgeMs = 15 * 60_000;
function age(sample, now) {
  const time = Date.parse(sample?.observed_at);
  return Number.isFinite(time) && time <= now ? now - time : Infinity;
}
const validSoc = reading => Number.isFinite(reading?.battery_percent) && reading.battery_percent >= 0 && reading.battery_percent <= 100;
const teslaSource = reading => ['TESLA_CACHED', 'TESLA_LIVE'].includes(reading?.source);
const readFailure = new Set(['busy', 'vehicle_unavailable', 'cache_unavailable', 'cache_unsupported', 'budget', 'permission', 'reauthorize', 'disabled', 'store', 'upstream', 'request_budget_exhausted']);
const routePlaces = input => input.navigationOnly === true ? [...(input.stops ?? []), input.destination] : [...(input.origin === undefined ? [] : [input.origin]), ...(input.stops ?? []), input.destination];
function replaceRoutePlace(input, index, query) {
  const hasOrigin = input.origin !== undefined, offset = hasOrigin ? 1 : 0;
  if (hasOrigin && index === 0) input.origin = query;
  else {
    const stopIndex = index - offset;
    if (stopIndex >= 0 && stopIndex < (input.stops ?? []).length) input.stops[stopIndex] = query;
    else if (index === offset + (input.stops ?? []).length) input.destination = query;
    else throw Error('invalid_arguments');
  }
}
const publicCandidate = (candidate, candidateIndex) => ({
  candidateIndex,name:candidate.name||candidate.display_name||null,city:candidate.city||null,
  state:candidate.state||null,street:candidate.street||null,house_number:candidate.house_number||null,
  postcode:candidate.postcode||null,operator:candidate.operator||candidate.brand||null,
  category:candidate.osm_key&&candidate.osm_value?candidate.osm_key+'/'+candidate.osm_value:null,
  source:candidate.source||null,source_url:candidate.source_url||null
});

export async function planSmartTrip(input, { backend, subject, now = Date.now, maps = invokeRoadTrip, plan = planChargingRoadTrip }) {
  const deadline = now() + 26_000;
  const result = (status, data = {}) => ({ status, sent_to_vehicle: false, ...data });
  if(input.continuationId!==undefined){
    const allowed=new Set(['externalMapsConsent','continuationId','placeSelections','placeCorrections']);
    if(Object.keys(input).some(k=>!allowed.has(k))||input.externalMapsConsent!==true||!backend.tripPlans?.getDraft)throw Error('invalid_arguments');
    const stored=await backend.tripPlans.getDraft(subject,input.continuationId);
    if(!stored.available)return result('itinerary_draft_unavailable',{reason:stored.reason});
    const route=structuredClone(stored.current_route_input??stored.route_input);
    const resolvedDraft=structuredClone(stored.resolved);
    for(let i=0;i<resolvedDraft.length;i++)if(resolvedDraft[i]?.reason==='map_provider_unavailable')resolvedDraft[i]=null;
    const changes=new Set();
    for(const selection of input.placeSelections??[]){
      const i=selection.placeIndex;
      if(changes.has(i)||!Number.isInteger(i)||i<0||i>=resolvedDraft.length||resolvedDraft[i]?.point||!Array.isArray(resolvedDraft[i]?.candidates))throw Error('invalid_arguments');
      const candidate=resolvedDraft[i].candidates[selection.candidateIndex];
      if(!candidate||!Number.isFinite(candidate.lat)||Math.abs(candidate.lat)>90||!Number.isFinite(candidate.lon)||Math.abs(candidate.lon)>180)throw Error('invalid_arguments');
      const original=routePlaces(route)[i];
      resolvedDraft[i]={point:{lat:candidate.lat,lon:candidate.lon},evidence:{query:original,source:candidate.source??'OSM_PUBLIC_MAP',name:candidate.name??null,
        city:candidate.city??null,osm_id:candidate.osm_id??null,osm_type:candidate.osm_type??null,source_url:candidate.source_url??null,
        source_updated_at:candidate.source_updated_at??null,retrieved_at:new Date().toISOString(),coordinate_status:'user_selected_map_candidate_not_exact_coordinate_confirmation'}};
      changes.add(i);
    }
    for(const correction of input.placeCorrections??[]){
      const i=correction.placeIndex;
      if(changes.has(i)||!Number.isInteger(i)||i<0||i>=resolvedDraft.length||typeof correction.query!=='string'||correction.query.trim().length<2||correction.query.length>200)throw Error('invalid_arguments');
      replaceRoutePlace(route,i,correction.query.trim());resolvedDraft[i]=null;changes.add(i);
    }
    const originalRoute=stored.original_route_input??stored.route_input;
    const priorClarifications=stored.clarified_indexes??[];
    const corrections=[...(stored.corrections??[]),...(input.placeCorrections??[]).map(x=>({placeIndex:x.placeIndex,query:x.query.trim()}))];
    input={...route,externalMapsConsent:true};
    input._continuation={id:stored.id,originalRoute,route,resolved:resolvedDraft,previousMetrics:stored.map_metrics??null,
      clarifiedIndexes:priorClarifications,corrections,clarificationRounds:stored.clarification_rounds??0,changed:changes.size>0};
  }
  if(input.allowAcCharging===true)throw Error('invalid_map_arguments');
  if(input.chargingRange && input.chargingRange.minimumPercent > input.chargingRange.maximumPercent)throw Error('invalid_map_arguments');
  if (input.externalMapsConsent !== true) throw Error('map_consent_required');
  const navigationOnly=input.navigationOnly===true;
  if(navigationOnly){
    const requested=[...(input.stops??[]),input.destination];
    if(input.origin!==undefined||input.roundTrip===true||requested.length<2||requested.length>4||requested.some(place=>typeof place!=='string'))
      return result('invalid_navigation_route',{reason:'navigation_only_requires_2_to_4_named_destinations_in_order_and_explicit_final_stop'});
  }
  const autoOrigin = !navigationOnly && input.origin === undefined, autoSoc = !navigationOnly && input.batteryPercent === undefined;
  if (!navigationOnly && autoOrigin && input.teslaLocationConsent !== true) return result('needs_location_consent');
  if (!navigationOnly && autoSoc && input.teslaBatteryConsent !== true) return result('needs_battery_consent');
  if (!navigationOnly && autoSoc && input.simulatedBattery === true) return result('needs_manual_battery');

  const continuation=input._continuation??null;
  const places = routePlaces(input);
  let resolved, mapMetrics;
  let privatePlaces;
  const lookupTasks = new Map(), lookupResults = new Map(), mapStarted = Date.now();
  const queryKey = value => normalizeSpeechDestinationQuery(value).query.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('it').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  try {
    resolved = await Promise.all(places.map(async (place, index) => {
      if (typeof place !== 'string') return { point: place, evidence: { query: null, source: 'USER_SUPPLIED', coordinate_status: 'supplied_not_independently_validated' } };
      const previous=continuation?.resolved[index];
      if(previous?.point)return previous;
      if(previous&&!['saved_place_missing','map_provider_unavailable'].includes(previous.reason))return previous;
      const alias=savedPlaceAlias(place);
      if(alias){privatePlaces??=backend.savedTripPlaces?.get(subject)??Promise.resolve({places:{}});const stored=(await privatePlaces).places[alias];
        return stored&&Number.isFinite(stored.lat)&&Number.isFinite(stored.lon)?{point:{lat:stored.lat,lon:stored.lon},source:'USER_CONFIRMED_ACCOUNT',evidence:{query:place,source:'USER_CONFIRMED_ACCOUNT',coordinate_status:'user_confirmed_account'}}:{query:place,candidates:[],reason:stored?.placeId?'saved_place_coordinates_unavailable':'saved_place_missing',alias};}
      const speech = normalizeSpeechDestinationQuery(place);
      const key = queryKey(place), duplicate = lookupTasks.has(key);
      if (!lookupTasks.has(key)) {
        const load = () => maps('search_trip_destination', { query: speech.query, externalMapsConsent: true }, {
          nominatimPermit: backend.acquirePublicGeocoderLease ? () => backend.acquirePublicGeocoderLease() : undefined
        });
        const task = backend.destinationCache?.resolve
          ? backend.destinationCache.resolve(subject, speech.query, load)
          : load().then(result => ({ result, cache_hit: false, request_deduplicated: false }));
        lookupTasks.set(key, task);
      }
      const lookup = await lookupTasks.get(key), found = lookup.result;
      if (!duplicate) lookupResults.set(key, lookup);
      if(found.query_resolution==='verified_public_poi_alias'&&found.selection_required===false&&Array.isArray(found.candidates)&&found.candidates.length===1&&found.candidates[0]?.matched_alias)
        return {point:{lat:found.candidates[0].lat,lon:found.candidates[0].lon},resolution_note:found.note??null,
          evidence:{query:place,source:found.source,name:found.candidates[0].name??null,city:found.candidates[0].city??null,
            osm_id:found.candidates[0].osm_id,osm_type:found.candidates[0].osm_type,source_url:found.candidates[0].source_url??null,
            source_updated_at:found.candidates[0].source_updated_at??null,retrieved_at:new Date().toISOString(),cache_hit:lookup.cache_hit===true,
            coordinate_status:'unique_public_map_match_not_user_confirmed',query_correction:speech.correction?.type??null},
          cache_hit:lookup.cache_hit,provider_calls:found.provider_calls??1};
      const candidates = resolveDestinationCandidates(speech.query, found.candidates);
      const match = candidates.length === 1 ? candidates[0] : null;
      return match ? { point: { lat: match.lat, lon: match.lon },
        resolution_note:found.address_precision==='street_segment_estimate'?'The house number was not present in the results. The OSM street segment is used as an estimated point, not a verified address.':null,
        evidence:{query:place,source:match.source??found.source,
        name:match.name??null,city:match.city??null,osm_id:match.osm_id,osm_type:match.osm_type,source_url:match.source_url??null,
        source_updated_at:match.source_updated_at??null,retrieved_at:new Date().toISOString(),cache_hit:lookup.cache_hit===true,
        address_precision:found.address_precision??'map_candidate',
        coordinate_status:found.address_precision==='street_segment_estimate'?'street_segment_estimate':'unique_public_map_match_not_user_confirmed',
        query_correction:speech.correction?.type??null},
        cache_hit:lookup.cache_hit,provider_calls:found.provider_calls??1 }
        : { query: place, candidates, cache_hit:lookup.cache_hit,provider_calls:found.provider_calls??1,
          reason:['provider_unavailable','providers_unavailable','rate_limiter_unavailable'].includes(found.fallback_status)?'map_provider_unavailable':'no_map_match',
          query_correction:speech.correction?.type??null };
    }));
    const uniqueQueries = [...lookupResults.entries()];
    const mapCalls = uniqueQueries.reduce((sum, [, value]) => sum + (value.cache_hit ? 0 : Number(value.result?.provider_calls ?? 1)), 0);
    const cacheHits = uniqueQueries.filter(([, value]) => value.cache_hit === true).length;
    mapMetrics = { schema_version: 1, geocoding_latency_ms: Math.max(0, Date.now() - mapStarted), unique_queries: uniqueQueries.length,
      duplicate_queries: Math.max(0, places.filter(place => typeof place === 'string' && !savedPlaceAlias(place)).length - uniqueQueries.length),
      provider_calls: mapCalls, cache_hits: cacheHits, cache_hit_rate: uniqueQueries.length ? cacheHits / uniqueQueries.length : 0 };
  } catch (error) {
    if (error.message !== 'map_provider_unavailable') throw error;
    const failedMetrics={ schema_version: 1, outcome:'maps_unavailable', geocoding_latency_ms: Math.max(0, Date.now() - mapStarted), unique_queries: lookupTasks.size,
      duplicate_queries: Math.max(0, places.filter(place => typeof place === 'string' && !savedPlaceAlias(place)).length - lookupTasks.size), provider_calls: 0, cache_hits: 0, cache_hit_rate: 0, clarification_count: 0 };
    console.info('ITINERARY_MAP_METRICS', JSON.stringify(failedMetrics));
    const routeInput=Object.fromEntries(Object.entries(input).filter(([k])=>k!=='_continuation'));
    let continuationId=continuation?.id??null;
    if(backend.tripPlans?.saveDraft&&(!continuation||continuation.changed))try{continuationId=(await backend.tripPlans.saveDraft(subject,{original_route_input:continuation?.originalRoute??routeInput,
      current_route_input:continuation?.route??routeInput,resolved:continuation?.resolved??places.map(()=>null),map_metrics:failedMetrics,
      clarified_indexes:continuation?.clarifiedIndexes??[],clarification_rounds:continuation?.clarificationRounds??0,corrections:continuation?.corrections??[]})).id;}catch{continuationId=null;}
    return result('maps_unavailable', { continuation_id: continuationId, map_metrics: failedMetrics });
  }
  if(continuation?.previousMetrics){
    const previous=continuation.previousMetrics,current=mapMetrics,total=Number(previous.unique_queries||0)+Number(current.unique_queries||0);
    mapMetrics={schema_version:1,geocoding_latency_ms:Number(previous.geocoding_latency_ms||0)+Number(current.geocoding_latency_ms||0),
      unique_queries:total,duplicate_queries:Number(previous.duplicate_queries||0)+Number(current.duplicate_queries||0),
      provider_calls:Number(previous.provider_calls||0)+Number(current.provider_calls||0),
      cache_hits:Number(previous.cache_hits||0)+Number(current.cache_hits||0),cache_hit_rate:total?(Number(previous.cache_hits||0)+Number(current.cache_hits||0))/total:0,
      clarification_count:continuation.clarificationRounds||0};
  }
  const unresolved = resolved.filter(item => !item.point);
  const hasAmbiguousPlaces=unresolved.some(item=>(item.candidates??[]).length>1);
  const hasUnavailableMap=unresolved.some(item=>item.reason==='map_provider_unavailable');
  const clarificationRounds=(continuation?.clarificationRounds??0)+(hasAmbiguousPlaces&&(!continuation||continuation.changed)?1:0);
  mapMetrics.clarification_count = clarificationRounds;
  mapMetrics.unresolved_place_count=unresolved.length;
  mapMetrics.outcome = hasUnavailableMap?'maps_unavailable':hasAmbiguousPlaces?'needs_place_selection':unresolved.length?'destination_not_found':'resolved';
  console.info('ITINERARY_MAP_METRICS', JSON.stringify(mapMetrics));
  if (unresolved.length) {
    const clarifiedIndexes=[...new Set([...(continuation?.clarifiedIndexes??[]),...resolved.flatMap((item,index)=>!item.point&&(item.candidates??[]).length>1?[index]:[])])];
    const originalRoute=continuation?.originalRoute??Object.fromEntries(Object.entries(input).filter(([k])=>k!=='_continuation'));
    const currentRoute=Object.fromEntries(Object.entries(input).filter(([k])=>k!=='_continuation'));
    let continuationId=continuation?.id??null,expires_at=null;
    if(backend.tripPlans?.saveDraft&&(!continuation||continuation.changed||continuation?.corrections?.length)){
      try { const draft=await backend.tripPlans.saveDraft(subject,{original_route_input:originalRoute,current_route_input:currentRoute,resolved,map_metrics:mapMetrics,
        clarified_indexes:clarifiedIndexes,clarification_rounds:clarificationRounds,corrections:continuation?.corrections??[]});continuationId=draft.id;expires_at=draft.expires_at; }
      catch { continuationId=null; }
    }else if(continuation){expires_at=(await backend.tripPlans.getDraft(subject,continuation.id)).expires_at;}
    const questions=resolved.flatMap((item,index)=>!item.point?[{placeIndex:index,query:item.query,alias:item.alias??null,
      reason:item.reason??'ambiguous_or_unmatched',candidates:(item.candidates??[]).map(publicCandidate)}]:[]);
    const status=unresolved.some(p=>['saved_place_missing','saved_place_coordinates_unavailable'].includes(p.reason))?'needs_saved_place':hasUnavailableMap?'maps_unavailable':hasAmbiguousPlaces?'needs_place_selection':'destination_not_found';
    return result(status,
      { places: questions, continuation_id:continuationId, continuation_expires_at:expires_at, continuation_state_saved:!!continuationId, map_metrics:mapMetrics });
  }

  if(navigationOnly){
    const destinations=resolved.map(item=>item.point);
    const route={origin:null,stops:[...(input.stops??[])],destination:input.destination,roundTrip:false};
    if(!backend.tripPlans?.save||!backend.tripPlans?.get)
      return result('itinerary_storage_unavailable',{map_metrics:mapMetrics,place_evidence:resolved.map(item=>item.evidence??null)});
    let savedPlan,stored;
    try{
      savedPlan=await backend.tripPlans.save(subject,{navigation_only:true,destinations,
        itinerary:{navigation_only:true},requested_route:route,resolved_route:route,
        requested_route_preferences:input.routePreferences??{},place_evidence:resolved.map(item=>item.evidence??null),
        clarification_count:mapMetrics.clarification_count??0,requires_verified_waypoint_identity:true});
      stored=await backend.tripPlans.get(subject,savedPlan.id);
    }catch{
      return result('itinerary_storage_unavailable',{map_metrics:mapMetrics});
    }
    const handoff=stored.multi_stop_navigation_handoff;
    const ready=handoff?.available===true;
    return result(ready?'multipoint_candidate_prepared':'multipoint_resolved_transport_blocked',{
      sent_to_vehicle:false,automatic_dispatch:false,
      ordered_destinations:destinations.map((point,index)=>({name:[...(input.stops??[]),input.destination][index],
        lat:point.lat,lon:point.lon,source:resolved[index].evidence?.source??null,
        source_url:resolved[index].evidence?.source_url??null})),
      place_evidence:resolved.map(item=>item.evidence??null),map_metrics:mapMetrics,
      routing_preferences:{requested:input.routePreferences??{},router_applied:false,applied_to_tesla:false,
        note:'Navigation-only mode prepares the stops; it does not set road preferences in Tesla navigation.'},
      navigation:{ordered_destinations:destinations,command:ready?handoff.command_request.operation:null,
        handoff,vehicle_route_verified:false,automatic_dispatch:false,requires_explicit_user_request:true},
      saved_plan:{id:savedPlan.id,retrieval_tool:'get_planned_trip',
        multi_stop_candidate_available:savedPlan.multi_stop_candidate_available===true,
        ...(savedPlan.multi_stop_candidate_available===true?{}:{reason:savedPlan.multi_stop_block_reason??handoff?.reason??'transport_unavailable'})}
    });
  }

  const originalRoute=continuation?.originalRoute??Object.fromEntries(Object.entries(input).filter(([k])=>k!=='_continuation'));
  const currentRoute=Object.fromEntries(Object.entries(input).filter(([k])=>k!=='_continuation'));
  let routeContextDraftId=null;
  if(backend.tripPlans?.saveDraft)try{
    routeContextDraftId=(await backend.tripPlans.saveDraft(subject,{original_route_input:originalRoute,current_route_input:currentRoute,resolved,
      map_metrics:mapMetrics,clarified_indexes:continuation?.clarifiedIndexes??[],clarification_rounds:continuation?.clarificationRounds??0,
      corrections:continuation?.corrections??[]})).id;
  }catch{routeContextDraftId=null;}
  const routeContextStatus=()=>routeContextDraftId?{route_continuation_id:routeContextDraftId,route_context_persisted:true}:{};

  const saved = await backend.preferences.get(subject);
  const prefs = saved.preferences ?? {};
  // These are bounded planning assumptions, not specifications of the connected vehicle.
  const usableCapacityKwh = prefs.usableCapacityKwh ?? 68;
  const consumptionKwhPer100Km = prefs.consumptionKwhPer100Km ?? 18;
  const efficiencyPercent = prefs.efficiencyPercent ?? 90;
  const reservePercent = Math.max(15, input.reservePercent ?? prefs.reservePercent ?? 15);
  const chargingTargetPercent = prefs.chargingTargetPercent ?? 85;
  if (reservePercent >= chargingTargetPercent) return result('invalid_reserve_target',routeContextStatus());

  let gps, reading, socQuality = input.simulatedBattery ? 'simulated' : 'user_supplied';
  let stage = 'vehicle';
  try {
    if (autoOrigin || autoSoc) await backend.withTripReadLease(async () => {
      const checkBudget = () => { if (deadline - now() < 7000) throw Error('request_budget_exhausted'); };
      if (autoSoc) {
        stage = 'battery';
        const cached = async () => {
          const history = await backend.vehicleReadingHistory(subject, 1);
          return history.readings.filter(item => validSoc(item) && teslaSource(item) && age(item, now()) <= maxSampleAgeMs)
            .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
        };
        checkBudget();
        if (input.batteryMode !== 'live') {
          reading = await cached();
          socQuality = reading ? 'recent_app_cache' : 'tesla_cache';
          if (!reading) { checkBudget(); reading = await backend.battery(subject); }
        } else {
          try { reading = await backend.battery(subject, { live: true }); socQuality = 'live'; }
          catch (error) {
            if (!['vehicle_unavailable','upstream'].includes(error.message) || input.allowCachedFallback !== true) throw error;
            reading = await cached();
            if (!reading) throw error;
            socQuality = 'recent_app_cache_fallback';
          }
        }
        if (!validSoc(reading) || !teslaSource(reading) || age(reading, now()) > maxSampleAgeMs) return;
      }
      if (autoOrigin) { stage = 'location'; checkBudget(); gps = await backend.location(subject); }
    });
  } catch (error) {
    if (!readFailure.has(error.message)) throw error;
    return result('vehicle_data_unavailable', { stage, reason: error.message,
      ...routeContextStatus(),
      ...(input.origin && typeof input.origin !== 'string' ? { available_origin: { ...input.origin, source: 'USER_SUPPLIED' } } : {}) });
  }
  if (autoSoc && (!validSoc(reading) || !teslaSource(reading) || age(reading, now()) > maxSampleAgeMs))
    return result('needs_fresh_soc', { ...routeContextStatus(),
      battery: { quality: 'unusable_or_stale', source: reading?.source ?? null, observed_at: reading?.observed_at ?? null } });
  if (autoOrigin && (!gps || age(gps, now()) > maxSampleAgeMs || !teslaSource(gps) ||
    !Number.isFinite(gps.latitude) || Math.abs(gps.latitude) > 90 || !Number.isFinite(gps.longitude) || Math.abs(gps.longitude) > 180))
    return result('needs_fresh_location', { ...routeContextStatus(),observed_at: gps?.observed_at ?? null });

  const points = resolved.map(item => item.point);
  const origin = autoOrigin ? { lat: gps.latitude, lon: gps.longitude } : points.shift();
  if(autoOrigin&&backend.tripPlans?.saveDraft)try{
    routeContextDraftId=(await backend.tripPlans.saveDraft(subject,{original_route_input:originalRoute,current_route_input:{...currentRoute,origin},resolved,
      map_metrics:mapMetrics,clarified_indexes:continuation?.clarifiedIndexes??[],clarification_rounds:continuation?.clarificationRounds??0,
      corrections:continuation?.corrections??[]})).id;
  }catch{routeContextDraftId=null;}
  const destination = points.pop();
  const batteryPercent = autoSoc ? reading.battery_percent : input.batteryPercent;
  const battery = { percent: batteryPercent, quality: socQuality, source: reading?.source ?? (input.simulatedBattery ? 'SIMULATED' : 'USER_SUPPLIED'),
    observed_at: reading?.observed_at ?? null, data_age_seconds: reading ? Math.floor(age(reading, now()) / 1000) : null };
  const remaining = deadline - now();
  if (remaining < 1500) return result('planning_timeout', { battery,...routeContextStatus() });
  let itinerary;
  try {
    itinerary = await plan({ origin, destination, stops: points, roundTrip: input.roundTrip ?? false,
      externalMapsConsent: true, batteryPercent, usableCapacityKwh, consumptionKwhPer100Km, reservePercent,
      chargingTargetPercent, maxChargingStops: 6, efficiencyPercent, objective: input.objective ?? 'cost',
      routePreferences: input.routePreferences ?? {},
      allowAcCharging:false,
      preferFreeToXMotorway: false,
      batterySource: autoSoc ? (reading.source === 'TESLA_LIVE' ? 'live' : 'cached') : input.simulatedBattery ? 'simulated' : 'user_supplied',
      ...(autoSoc ? { batterySampledAt: reading.observed_at } : {}) },
    { budgetMs: Math.min(PLANNER_BUDGET_MS, remaining) });
  } catch (error) {
    if (error.message !== 'map_provider_unavailable') throw error;
    return result('maps_unavailable', { battery,...routeContextStatus() });
  }
  const { sites, diagnostics, battery_input, ...summary } = itinerary;
  const destinations = summary.navigation_destinations ?? summary.points?.slice(1) ?? [...points, destination, ...(input.roundTrip ? [origin] : [])];
  const multiStop = destinations.length > 1;
  const destinationResolutionNotes=resolved.flatMap((item,index)=>item.resolution_note?[{query:typeof places[index]==='string'?places[index]:null,note:item.resolution_note}]:[]);
  const navigation = { multi_stop_transport_supported: false, requires_separate_explicit_request: true,
    ordered_destinations: destinations, energy_verified: summary.charging_plan?.feasible === true,
    next_destination: !multiStop&&summary.charging_plan?.feasible === true ? destinations[0] ?? null : null,
    command: multiStop ? null : 'navigation_request', via_existing_tool: multiStop ? null : 'execute_requested_vehicle_command',
    automatic_dispatch: false, iphone_app_sync: 'not_verifiable',
    handoff:multiStop?{available:false,reason:'multi_stop_requires_verified_waypoints',command_request:null,automatic_dispatch:false}:
      summary.charging_plan?.feasible===true?tripDestinationHandoff(destinations):{available:false,reason:'energy_not_verified',command_request:null} };
  if (backend.tripPlans) {
    const routeIntent = { origin: originalRoute.origin ?? (autoOrigin ? { source: 'TESLA_GPS_CAPTURED', observed_at: gps?.observed_at ?? null } : null),
      stops: originalRoute.stops ?? [], destination: originalRoute.destination, roundTrip: originalRoute.roundTrip ?? false };
    const resolvedRoute = { origin: input.origin ?? (autoOrigin ? { source: 'TESLA_GPS_CAPTURED', observed_at: gps?.observed_at ?? null } : null),
      stops: input.stops ?? [], destination: input.destination, roundTrip: input.roundTrip ?? false };
    const routePreferences = originalRoute.routePreferences ?? {};
    const chargingRange = originalRoute.chargingRange ?? null;
    try { navigation.saved_plan = await backend.tripPlans.save(subject, { origin, destinations, itinerary: summary,
      requested_route: routeIntent, place_evidence: resolved.map(item=>item.evidence??null), requested_route_preferences: routePreferences,
      requested_charging_range: chargingRange,resolved_route:resolvedRoute,place_corrections:continuation?.corrections??[],
      clarification_count:mapMetrics.clarification_count??0,requires_verified_waypoint_identity:multiStop }); }
    catch { navigation.saved_plan = { available: false, reason: 'itinerary_storage_unavailable' }; }
    if(navigation.saved_plan?.multi_stop_candidate_available===true){navigation.multi_stop_transport_supported=true;navigation.multi_stop_vehicle_verified=false;navigation.whole_route_preparation={tool:'get_planned_trip',id:navigation.saved_plan.id,experimental:true,automatic_dispatch:false};}
  }
  return result(summary.charging_plan?.feasible === true ? (input.simulatedBattery ? 'simulated_plan' : 'estimated_plan') : 'charging_unverified', {
    battery, origin: { source: gps?.source ?? 'USER_SUPPLIED', observed_at: gps?.observed_at ?? null },
    map_metrics: mapMetrics, place_evidence: resolved.map(item=>item.evidence??null),
    routing_preferences: summary.routing_preferences ?? { requested: input.routePreferences ?? {},planner_query_applied:false,
      excluded_osrm_classes:[],unsupported_preferences:Object.keys(input.routePreferences??{}).length?Object.keys(input.routePreferences):[],
      applied_to_tesla:false,real_world_avoidance_verified:false,
      note:'No route preference provider result was returned; do not claim that the route or Tesla navigation applied these preferences.' },
    charging_range: input.chargingRange ? { requested: input.chargingRange, applied_to_planner: false,
      reason: 'planner_uses_a_single_target_and_reserve_not_a_user_range' } : null,
    preferences: { initialized: saved.initialized, updated_at: saved.updated_at },
    ...(destinationResolutionNotes.length?{destination_resolution_notes:destinationResolutionNotes}:{}),
    assumptions: Object.fromEntries(Object.entries({ usableCapacityKwh, consumptionKwhPer100Km, efficiencyPercent })
      .map(([key, value]) => [key, { value, source: prefs[key] === undefined ? 'planning_estimate' : 'account_preference', observed_at: prefs[key] === undefined ? null : saved.updated_at }])),
    global_economic_optimum_verified: false,
    navigation,
    charging_recommendation: {
      required: summary.direct_energy_assessment?.charging_required ?? null,
      status: summary.charging_plan?.feasible === true ? (summary.charging_plan.stops?.length ? 'charging_planned' : 'no_charging_needed') : 'charging_not_verified',
      reserve_percent: reservePercent, minimum_reserve_percent: 15,
      direct_arrival_percent: summary.direct_energy_assessment?.estimated_arrival_percent ?? null,
      planned_arrival_percent: summary.charging_plan?.estimated_arrival_percent ?? null,
      price_comparison: summary.charging_plan?.economic_comparison ?? null,
      connector_scope:'CCS2_DC',
      ac_charging:{enabled:false,policy:'separate_explicit_area_search_only',search_tool:'find_charging_sites',connectorType:'AC'},
      action_required: summary.charging_plan?.feasible === true ? 'review_plan' : 'find_reachable_charging_before_departure',
      automatic_dispatch: false
    },
    itinerary: summary
  });
}


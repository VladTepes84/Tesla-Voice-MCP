import { randomUUID } from 'node:crypto';
import { loadEuropeanStations } from './european-stations.mjs';
import { optimizeCharging } from './charging-itinerary.mjs';
import { chargingTariffSchema } from './charge-cost-comparison.mjs';
import { mapClient } from './map-providers.mjs';
import { jsonFetch } from './security.mjs';
import { estimateTripEnergy } from './energy-estimate.mjs';
import { normalizeSpeechDestinationQuery, resolveDestinationCandidates, streetQueryWithoutHouseNumber } from './destination-resolution.mjs';
import { destinationAliasFor, resolveDestinationAliasCandidate } from './destination-aliases.mjs';
import { savedPlaceAlias } from './saved-trip-places.mjs';
import { normalizeOsmCharging, osmAreaQuery } from './osm-charging.mjs';

const pointSchema = { type: 'object', properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 } }, required: ['lat', 'lon'], additionalProperties: false };
const consent = { type: 'boolean', const: true };
const routePreferences = { type:'object',additionalProperties:false,properties:{
  avoidTolls:{type:'boolean'},avoidHighways:{type:'boolean'},avoidMotorways:{type:'boolean'},
  preferredRoads:{type:'array',maxItems:5,items:{type:'string',minLength:2,maxLength:100}}
} };
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const securitySchemes = [{ type: 'oauth2', scopes: ['location:read'] }];
export const roadTripTools = [
  { name: 'reverse_trip_location', description: 'Resolves explicit coordinates to a street, house number, and municipality using Photon/OSM, with consent to send coordinates. Returns the closest map feature, not a guarantee of an exact street number. Does not read Tesla.', inputSchema: { type:'object', properties:{ center:pointSchema, externalMapsConsent:consent }, required:['center','externalMapsConsent'], additionalProperties:false }, annotations, securitySchemes },
  { name: 'search_trip_destination', description: 'Searches for places with Photon/OpenStreetMap. Sends query text to the public map service only with consent. Shows candidates with city/country; ask the user to choose if ambiguous. Resolve Home only from a confirmed private account place; if missing, do not search for it publicly. Does not read Tesla.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 200 }, externalMapsConsent: consent }, required: ['query', 'externalMapsConsent'], additionalProperties: false }, annotations, securitySchemes },
  { name: 'plan_road_trip', description: 'Calculates an OSRM road route with stops and optional return, distance, and estimated energy use. Passes requested motorway/toll exclusions only when supported by the provider profile and OSM tags; these do not apply preferences to Tesla navigation. Preferred road names are informational only. Sends coordinates to the public service only with consent. Uses separately authorized GPS or a supplied origin; does not read Tesla, send destinations, or choose charging stops automatically. Requires explicit capacity and consumption. No traffic or weather forecast.', inputSchema: { type: 'object', properties: { origin: pointSchema, destination: pointSchema, stops: { type: 'array', items: pointSchema, maxItems: 8 }, roundTrip: { type: 'boolean' }, routePreferences, chargingOptions: { type: 'array', maxItems: 10, items: { anyOf: [chargingTariffSchema, {type:'null'}] } }, efficiencyPercent: {type:'number',minimum:1,maximum:100}, batteryPercent: { type: 'number', minimum: 0, maximum: 100 }, usableCapacityKwh: { type: 'number', minimum: 1, maximum: 250 }, consumptionKwhPer100Km: { type: 'number', minimum: 1, maximum: 100 }, reservePercent: { type: 'number', minimum: 0, maximum: 100 }, externalMapsConsent: consent }, required: ['origin', 'destination', 'roundTrip', 'batteryPercent', 'usableCapacityKwh', 'consumptionKwhPer100Km', 'reservePercent', 'externalMapsConsent'], additionalProperties: false }, annotations, securitySchemes },
  { name: 'find_charging_sites', description: 'Finds charging sites within a radius of an explicit point. For an AC area search, set connectorType to AC. For DC, use connectorType DC; CCS2 selects CCS2 sites. Without a filter, searches for DC CCS2 for compatibility with the earlier schema. OSM data depends on available tags and does not guarantee vehicle compatibility. Results combine national catalogs with OpenStreetMap via Overpass where configured; coverage and availability are not guaranteed. Returns execution_evidence and explicitly incomplete coverage; an empty list does not prove no sites exist. Use public map data only with explicit consent or a saved chargingMapsConsent preference; do not ask again when that preference is active. May include Tesla, Free To X, and other mapped operators. Live availability and prices are not verified; do not treat OSM tags as current tariffs. Does not read Tesla.', inputSchema: { type: 'object', properties: { center: pointSchema, connectorType:{type:'string',enum:['AC','CCS2','DC']}, radiusKm: { type: 'number', minimum: 1, maximum: 20 }, externalMapsConsent: consent }, required: ['center', 'radiusKm'], additionalProperties: false }, annotations, securitySchemes }
];
const finite = (x, a, b) => typeof x === 'number' && Number.isFinite(x) && x >= a && x <= b;
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !fields.includes(k))) throw Error('invalid_map_arguments');
}
function point(p) { exact(p, ['lat', 'lon']); if (!finite(p.lat, -90, 90) || !finite(p.lon, -180, 180)) throw Error('invalid_map_arguments'); return p; }
const attribution = '© OpenStreetMap contributors, ODbL; public services are provided without an availability guarantee.';
const osmElementUrl = (type, id) => ({ N: 'node', W: 'way', R: 'relation' }[String(type || '').toUpperCase()] && Number.isSafeInteger(Number(id)) && Number(id)>0
  ? `https://www.openstreetmap.org/${{ N: 'node', W: 'way', R: 'relation' }[String(type || '').toUpperCase()]}/${Number(id)}` : null);
// Fixed origins prevent caller-controlled URLs, credentials or redirects.
export async function invokeRoadTrip(name, input, { fetcher = fetch, catalogLoader = loadEuropeanStations, nominatimPermit, osmCharging } = {}) {
  const definition = roadTripTools.find(t => t.name === name);
  if (!definition) throw Error('invalid_map_arguments');
  exact(input, Object.keys(definition.inputSchema.properties));
  if (input.externalMapsConsent !== true) throw Error('map_consent_required');
  const get = async (url, options) => {
    try { return await jsonFetch(fetcher, url, { ...options, headers: { 'user-agent': 'TeslaVoiceMCP/1.0', ...options?.headers } }); }
    catch { throw Error('map_provider_unavailable'); }
  };
  if (name === 'reverse_trip_location') {
    const p = point(input.center);
    const url = new URL('https://photon.komoot.io/reverse');
    url.searchParams.set('lat', String(p.lat)); url.searchParams.set('lon', String(p.lon));
    url.searchParams.set('radius','0.1'); url.searchParams.set('limit','1');
    const data = await get(url.href);
    if (!Array.isArray(data.features)) throw Error('map_provider_unavailable');
    const feature = data.features[0], [lon, lat] = feature?.geometry?.coordinates || [];
    const clean = v => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,200) : '';
    const props = feature?.properties || {};
    const radians = x => x * Math.PI / 180;
    const a = Math.sin(radians(lat - p.lat)/2)**2 + Math.cos(radians(lat))*Math.cos(radians(p.lat))*Math.sin(radians(lon - p.lon)/2)**2;
    const distance = 6371000 * 2 * Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
    if (!finite(lat,-90,90) || !finite(lon,-180,180) || !finite(distance,0,100)) return { source:'PHOTON_OSM', address_available:false, exact_address_verified:false, reason:'no_nearby_map_match', attribution };
    const street = clean(props.street || (props.osm_key === 'highway' ? props.name : ''));
    const house_number = street ? clean(props.housenumber) : '';
    const city = clean(props.city), country = clean(props.country), postcode = clean(props.postcode);
    return { source:'PHOTON_OSM', address_available:!!street, street:street || null, house_number:house_number || null, city:city || null, postcode:postcode || null, country:country || null,
      spoken_address:[street && [street,house_number].filter(Boolean).join(' '),city,country].filter(Boolean).join(', ') || null,
      precision: house_number ? 'nearby_house_candidate' : street ? 'street' : 'locality_only', map_match_distance_m:Math.round(distance), exact_address_verified:false, attribution,
      note:'Nearby map address derived from GPS. The exact house number and side of the road are unverified.' };
  }
  if (name === 'search_trip_destination') {
    if (typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > 200) throw Error('invalid_map_arguments');
    if(savedPlaceAlias(input.query))return {source:'PRIVATE_ACCOUNT_ALIAS_REQUIRED',candidates:[],selection_required:true,reason:'saved_place_requires_account_resolution',external_query_performed:false};
    const speech = normalizeSpeechDestinationQuery(input.query.trim());
    const alias = destinationAliasFor(speech.query);
    const lookupQuery = alias?.providerQuery ?? speech.query.trim();
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', lookupQuery); url.searchParams.set('limit', '10');
    let data,photonFailed=false;
    try { data=await get(url.href); } catch(error) { if(error.message!=='map_provider_unavailable')throw error;photonFailed=true;data={features:[]}; }
    if (!Array.isArray(data.features)) { photonFailed=true;data={features:[]}; }
    const mapPhoton = features => features.slice(0, 10).flatMap(f => {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (!finite(lat, -90, 90) || !finite(lon, -180, 180)) return [];
      const p = f.properties || {};
      return [{ lat, lon, name: String(p.name || '').slice(0, 200), city: String(p.city || '').slice(0, 100), country: String(p.country || '').slice(0, 100),
        street:String(p.street||'').slice(0,200),house_number:String(p.housenumber||'').slice(0,30),postcode:String(p.postcode||'').slice(0,30),
        state: String(p.state || '').slice(0,100), district: String(p.district || '').slice(0,100),
        operator:String(p.operator||'').slice(0,100),brand:String(p.brand||'').slice(0,100),
        osm_key: String(p.osm_key || '').slice(0,40), osm_value: String(p.osm_value || '').slice(0,40),
        osm_id: Number.isSafeInteger(p.osm_id) ? p.osm_id : null, osm_type: String(p.osm_type || '').slice(0,10),
        source_url:osmElementUrl(p.osm_type,p.osm_id),source_updated_at:null,source: 'PHOTON_OSM' }];
    });
    const photon = mapPhoton(data.features);
    let candidates = alias ? (resolveDestinationAliasCandidate(alias, photon) ? [resolveDestinationAliasCandidate(alias, photon)] : [])
      : resolveDestinationCandidates(speech.query, photon);
    let source = 'PHOTON_OSM', providerCalls = 1, fallbackStatus = photonFailed?'photon_unavailable':'not_needed', addressPrecision = 'map_candidate';
    // Nominatim is a bounded fallback only for an on-demand query with no
    // Photon match or an unavailable Photon response. A distributed Redis
    // lease is mandatory; without it, provider failure remains explicit.
    if (!candidates.length && typeof nominatimPermit === 'function') {
      let lease;
      try { lease = await nominatimPermit(); } catch { lease = null; }
      if (lease) {
        try {
          const nominatimUrl = new URL('https://nominatim.openstreetmap.org/search');
          nominatimUrl.searchParams.set('q', lookupQuery);
          nominatimUrl.searchParams.set('format', 'jsonv2');
          nominatimUrl.searchParams.set('addressdetails', '1');
          nominatimUrl.searchParams.set('limit', '10');
          nominatimUrl.searchParams.set('accept-language', 'it');
          providerCalls++;
          const rows = await get(nominatimUrl.href, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
          if (!Array.isArray(rows)) throw Error('map_provider_unavailable');
          const nominatim = rows.slice(0, 10).flatMap(row => {
            const lat = Number(row.lat), lon = Number(row.lon), a = row.address || {};
            if (!finite(lat, -90, 90) || !finite(lon, -180, 180)) return [];
            const city = a.city || a.town || a.village || a.municipality || a.hamlet || '';
            const typeMap = { node: 'N', way: 'W', relation: 'R' };
            return [{ lat, lon, name: String(row.name || row.namedetails?.name || '').slice(0, 200),
              display_name: String(row.display_name || '').slice(0, 300), city: String(city).slice(0, 100),
              country: String(a.country || '').slice(0, 100), street: String(a.road || a.pedestrian || a.footway || '').slice(0, 200),
              house_number: String(a.house_number || '').slice(0, 30), postcode: String(a.postcode || '').slice(0, 30),
              state: String(a.state || '').slice(0, 100), district: String(a.city_district || a.county || '').slice(0, 100),
              osm_key: String(row.category || '').slice(0, 40), osm_value: String(row.type || '').slice(0, 40),
              osm_id: Number.isSafeInteger(Number(row.osm_id)) ? Number(row.osm_id) : null,
              osm_type: typeMap[row.osm_type] || '',source_url:osmElementUrl(typeMap[row.osm_type],row.osm_id),source_updated_at:null,source: 'NOMINATIM_OSM' }];
          });
          source = 'NOMINATIM_OSM';
          candidates = alias ? (resolveDestinationAliasCandidate(alias, nominatim) ? [resolveDestinationAliasCandidate(alias, nominatim)] : [])
            : resolveDestinationCandidates(speech.query, nominatim);
          fallbackStatus = candidates.length ? 'matched' : 'no_match';
        } catch {
          // Keep the empty Photon result. No repeated search or mirror rotation.
          fallbackStatus = photonFailed?'providers_unavailable':'provider_unavailable';
        } finally { try { await lease.release?.(); } catch {} }
      } else {
        fallbackStatus = photonFailed?'providers_unavailable':'fallback_not_run';
      }
    }
    // If a precise house-number query has no exact map match, make one bounded
    // street-level Photon search. A street segment is explicitly labelled as
    // an estimate; a different numbered address is never substituted.
    const streetQuery=streetQueryWithoutHouseNumber(speech.query);
    if(!candidates.length&&!alias&&streetQuery){
      try {
        const streetUrl=new URL('https://photon.komoot.io/api/');
        streetUrl.searchParams.set('q',streetQuery);streetUrl.searchParams.set('limit','10');providerCalls++;
        const streetData=await get(streetUrl.href);
        if(Array.isArray(streetData.features)){
          const streetRows=mapPhoton(streetData.features).filter(candidate=>!candidate.house_number);
          const streetCandidates=resolveDestinationCandidates(streetQuery,streetRows);
          if(streetCandidates.length){candidates=streetCandidates;source='PHOTON_OSM';addressPrecision='street_segment_estimate';fallbackStatus='street_segment_match';}
        }
      }catch{/* Keep the exact and Nominatim results; never fabricate a street point. */}
    }
    const correction = speech.correction ? { type: speech.correction.type, corrected_query: speech.correction.to } : undefined;
    if(!candidates.length&&['photon_unavailable','provider_unavailable','providers_unavailable'].includes(fallbackStatus))throw Error('map_provider_unavailable');
    if (alias && candidates.length !== 1) return { source, candidates:[], selection_required:true, reason:'known_poi_map_match_unavailable', provider_calls:providerCalls,fallback_status:fallbackStatus,
      ...(correction ? { query_correction: correction } : {}), attribution };
    if (alias) return { source, candidates, selection_required:false, query_resolution:'verified_public_poi_alias', lookup_query:lookupQuery,
      provider_calls:providerCalls,fallback_status:fallbackStatus,
      note:'Place identity is based on map data; the exact entrance is not verified.',
      ...(correction ? { query_correction: correction } : {}), attribution };
    if(addressPrecision!=='street_segment_estimate')addressPrecision=candidates.length===1&&candidates[0].house_number?'house_number_match':'map_candidate';
    return { source, candidates, selection_required: candidates.length !== 1, provider_calls:providerCalls,fallback_status:fallbackStatus,address_precision:addressPrecision,
      ...(correction ? { query_correction: correction } : {}), attribution };
  }
  const maps=mapClient(fetcher,{routePreferences:input.routePreferences??{}});
  if (name === 'find_charging_sites') {
    const p = point(input.center);
    if (!finite(input.radiusKm, 1, 20)) throw Error('invalid_map_arguments');
    const started=Date.now(),connector=input.connectorType??'CCS2';
    if(!['AC','CCS2','DC'].includes(connector))throw Error('invalid_map_arguments');
    const loadOsm=osmCharging??(catalogLoader===loadEuropeanStations?(query=>maps.charging(query)):null);
    const [nationalResult,osmResult]=await Promise.allSettled([
      catalogLoader({fetcher,includeAc:connector==='AC'}),
      loadOsm?loadOsm(osmAreaQuery(p,input.radiusKm)):Promise.reject(Error('not_configured'))
    ]);
    const catalog=nationalResult.status==='fulfilled'?nationalResult.value:{stations:[],sources:[{country:'national',status:'unavailable'}]};
    let osmSites=[],osmStatus='unavailable';
    if(osmResult.status==='fulfilled')try{osmSites=normalizeOsmCharging(osmResult.value,{includeAc:connector==='AC'});osmStatus='ok';}catch{}
    if(loadOsm)catalog.sources=[...(catalog.sources??[]),{country:'OSM',status:osmStatus,download_complete:false,station_count:osmSites.length}];
    const radians=v=>v*Math.PI/180;
    const distance=s=>{const a=Math.sin(radians(s.lat-p.lat)/2)**2+Math.cos(radians(p.lat))*Math.cos(radians(s.lat))*Math.sin(radians(s.lon-p.lon)/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));};
    const matched=[...catalog.stations,...osmSites].filter(s=>connector==='AC'?s.connectorType==='AC':connector==='DC'?(s.ccs2===true||s.connectorType==='DC'):s.ccs2===true)
      .map(s=>({...s,straight_line_distance_km:distance(s)})).filter(s=>s.straight_line_distance_km<=input.radiusKm).sort((a,b)=>a.straight_line_distance_km-b.straight_line_distance_km);
    const sources=catalog.sources??[];
    const searchStatus=matched.length?'partial_results':sources.some(s=>s.status==='ok')?'no_matches_in_partial_catalog':'sources_unavailable';
    const evidence={tool:'find_charging_sites',backend:'TESLA_MCP',execution_reference:randomUUID(),completed_at:new Date().toISOString(),connector_type:connector,elapsed_ms:Date.now()-started};
    console.info('CHARGING_AREA_SEARCH',JSON.stringify({...evidence,search_status:searchStatus,station_count:Math.min(100,matched.length)}));
    return {source:loadOsm?'NATIONAL_AND_OSM_AREA_SEARCH':'OFFICIAL_NATIONAL_CATALOG_AREA_SEARCH',connector_type:connector,search_status:searchStatus,
      execution_evidence:evidence,sites:matched.slice(0,100),truncated:matched.length>100,
      coverage_complete:false,sources,attribution:[catalog.attribution,'© OpenStreetMap contributors, ODbL'].filter(Boolean).join('; '),vehicle_read_performed:false,sent_to_vehicle:false,
      tariffs_verified:false,availability_verified:false,limitation:'Area search only; distances are geographic, not road detours or proof of motorway access. Empty results do not prove absence of stations in incomplete catalogs; duplicate records may occur across sources.'};
  }

  point(input.origin); point(input.destination);
  if (typeof input.roundTrip !== 'boolean' || (input.stops !== undefined && (!Array.isArray(input.stops) || input.stops.length > 8))) throw Error('invalid_map_arguments');
  const points = [input.origin, ...(input.stops || []).map(point), input.destination, ...(input.roundTrip ? [input.origin] : [])];
  // Validate energy inputs before any network request.
  estimateTripEnergy({ ...input, distanceKm: 0 });
  if (input.chargingOptions !== undefined) optimizeCharging({ legs: Array.from({length: points.length-1}, () => ({distance_km:0})), options: input.chargingOptions, capacityKwh: input.usableCapacityKwh, ...input });
  const path = points.map(p => `${p.lon},${p.lat}`).join(';');
  const data = await maps.routing(`/route/v1/driving/${path}?overview=false&steps=false&alternatives=false&radiuses=${points.map(() => 1000).join(';')}`, data=>data.code==='Ok'&&Array.isArray(data.routes?.[0]?.legs)&&data.routes[0].legs.length===points.length-1&&finite(data.routes[0].distance,0,10000000)&&finite(data.routes[0].duration,0,10000000)&&data.routes[0].legs.every(l=>finite(l.distance,0,10000000)&&finite(l.duration,0,10000000)));
  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route || !Array.isArray(route.legs) || route.legs.length !== points.length - 1 || !finite(route.distance, 0, 10000000) || !finite(route.duration, 0, 10000000) || route.legs.some(l => !finite(l.distance, 0, 10000000) || !finite(l.duration, 0, 10000000))) throw Error('map_provider_unavailable');
  const energy = estimateTripEnergy({ ...input, distanceKm: route.distance / 1000 });
  const charging = input.chargingOptions === undefined ? null : optimizeCharging({ legs: route.legs.map(l => ({distance_km:l.distance/1000})), options: input.chargingOptions, capacityKwh: input.usableCapacityKwh, ...input });
  return { diagnostics:maps.diagnostics,routing_preferences:maps.routePreferenceReport(),fix_map_url:'https://www.openstreetmap.org/fixthemap', charging_plan: charging, source: 'OSRM_ROAD_ROUTE', points, round_trip: input.roundTrip, distance_km: route.distance / 1000, duration_minutes_without_live_traffic: route.duration / 60, legs: route.legs.map(l => ({ distance_km: l.distance / 1000, duration_minutes: l.duration / 60 })), energy, charging_stops_selected: false, sent_to_vehicle: false, tariffs_verified: false, attribution };
}

import { jsonFetch } from './security.mjs';
import { savedPlaceAlias } from './saved-trip-places.mjs';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,nextPageToken';
const MAX_STOPS = 16;
const MAX_CANDIDATES = 5;
const PLACE_PROOF_TTL_SECONDS = 6 * 60 * 60;
const isValidPlaceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeText = (value, maxLength) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);

export const resolveWaypointPlacesTool = {
  name: 'resolve_waypoint_places',
  description: 'Primary resolver for Google Places multipoint navigation. Sends place names only after explicit consent. For Home and Work, uses only private Place IDs already saved and confirmed in this connector; if missing, returns needs_saved_place and does not search Google. Resolves 2–16 ordered destinations, requires the user to choose among ambiguous results, and prepares waypoint references without sending commands or reading Tesla. A Google Place ID does not certify a Tesla charging site or prove that a route will appear on the vehicle display.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['externalMapsConsent', 'stops'],
    properties: {
      externalMapsConsent: { type: 'boolean', const: true },
      stops: { type: 'array', minItems: 2, maxItems: MAX_STOPS, items: {
        type: 'object', additionalProperties: false, required: ['query'], properties: {
          query: { type: 'string', minLength: 2, maxLength: 200 },
          selectedPlaceId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }
        }
      } }
    }
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  securitySchemes: [{ type: 'oauth2', scopes: ['location:read'] }]
};

// Never fall back to GOOGLE_MAPS_DEMO_API_KEY. The dedicated key and flag are
// supplied only by the server runtime, and this code cannot enable them.
export function googlePlacesProductionEnabled(env = process.env) {
  const apiKey = env?.GOOGLE_PLACES_API_KEY;
  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const demoKey = typeof env?.GOOGLE_MAPS_DEMO_API_KEY === 'string' ? env.GOOGLE_MAPS_DEMO_API_KEY.trim() : '';
  return env?.VERCEL_ENV === 'production' && env.GOOGLE_PLACES_SEARCH_ENABLED === 'true' &&
    normalizedKey.length > 0 && (!demoKey || normalizedKey !== demoKey);
}

function validateInput(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['externalMapsConsent', 'stops'].includes(key)) ||
      input.externalMapsConsent !== true || !Array.isArray(input.stops) ||
      input.stops.length < 2 || input.stops.length > MAX_STOPS) throw Error('invalid_map_arguments');
  for (const stop of input.stops) {
    if (!plainObject(stop) || Object.keys(stop).some(key => !['query', 'selectedPlaceId'].includes(key)) ||
        typeof stop.query !== 'string' || stop.query.trim().length < 2 || stop.query.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(stop.query) ||
        stop.selectedPlaceId !== undefined && !isValidPlaceId(stop.selectedPlaceId)) {
      throw Error('invalid_map_arguments');
    }
  }
}

function unavailableResult(reason) {
  return { source: 'GOOGLE_PLACES_API_NEW', candidates: [], reason, fallback_status: 'provider_unavailable' };
}

async function searchGoogle(query, { apiKey, fetcher, destinationCache, subject }) {
  let cached;
  try {
    cached = await destinationCache.resolve(subject, `google-places:${query}`, async () => {
      let reserved;
      try { reserved = await destinationCache.reserveGooglePlacesRequest(); }
      catch { return unavailableResult('google_places_quota_unavailable'); }
      if (reserved !== true) return unavailableResult('google_places_daily_limit');

      let body;
      try {
        body = await jsonFetch(fetcher, SEARCH_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': SEARCH_FIELD_MASK
          },
          body: JSON.stringify({ textQuery: query, pageSize: MAX_CANDIDATES })
        }, {}, 8000);
      } catch {
        return unavailableResult('google_places_unavailable');
      }

      if (body?.places !== undefined && (!Array.isArray(body.places) || body.places.length > MAX_CANDIDATES) ||
          body?.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') {
        return unavailableResult('google_places_invalid_response');
      }
      const places = body?.places ?? [];
      const ids = new Set();
      if (places.some(place => {
        const name = typeof place?.displayName?.text === 'string' ? safeText(place.displayName.text, 200) : '';
        const address = typeof place?.formattedAddress === 'string' ? safeText(place.formattedAddress, 300) : '';
        if (!isValidPlaceId(place?.id) || !name || !address || ids.has(place.id)) return true;
        ids.add(place.id);
        return false;
      })) return unavailableResult('google_places_invalid_response');

      return {
        source: 'GOOGLE_PLACES_API_NEW',
        candidates: places.map(place => ({
          placeId: place.id,
          name: safeText(place.displayName.text, 200),
          address: safeText(place.formattedAddress, 300)
        })),
        more_candidates_possible: !!body?.nextPageToken || places.length === MAX_CANDIDATES
      };
    });
  } catch {
    return { result: unavailableResult('google_places_quota_unavailable'), cache_hit: false };
  }
  if (!cached?.result || cached.result.source !== 'GOOGLE_PLACES_API_NEW' || !Array.isArray(cached.result.candidates)) {
    return { result: unavailableResult('google_places_invalid_response'), cache_hit: cached?.cache_hit === true };
  }
  return cached;
}

export async function resolveWaypointPlaces(input, {
  apiKey, enabled = false, nativeWaypointsEnabled = false, fetcher = fetch, destinationCache, subject, savedTripPlaces
} = {}) {
  validateInput(input);
  if (enabled !== true || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { status: 'places_not_configured', stops: [], command_request: null, sent_to_vehicle: false };
  }
  if (nativeWaypointsEnabled !== true) {
    return { status: 'native_waypoints_disabled', stops: [], command_request: null, sent_to_vehicle: false };
  }
  if (typeof subject !== 'string' || !subject || typeof destinationCache?.resolve !== 'function' ||
      typeof destinationCache?.reserveGooglePlacesRequest !== 'function' ||
      typeof destinationCache?.attestGooglePlaceIds !== 'function') {
    return { status: 'google_places_quota_unavailable', stops: [], command_request: null, sent_to_vehicle: false };
  }

  // Preflight private aliases before any chargeable Google request.
  // A missing alias must not leak to text search or consume the daily quota.
  const requestedAliases = input.stops.map(s => savedPlaceAlias(s.query.trim())).filter(Boolean);
  let privatePlaces = {}, privatePlaceIds = {};
  if (requestedAliases.length) {
    try {
      const saved=await savedTripPlaces?.get(subject);
      privatePlaces=saved?.places??{};
      privatePlaceIds=saved?.google_place_ids??{};
    }
    catch { return {status:'needs_saved_place',reason:'saved_place_unavailable',stops:[],command_request:null,sent_to_vehicle:false,dispatch_performed:false}; }
    const missing = [...new Set(requestedAliases)].filter(alias => !isValidPlaceId(privatePlaceIds[alias]??privatePlaces[alias]?.placeId));
    if (missing.length) return {status:'needs_saved_place',missing_aliases:missing,
      reason:missing.some(alias=>privatePlaces[alias]?'saved_place_refid_required':'saved_place_missing'),
      stops:[],command_request:null,sent_to_vehicle:false,dispatch_performed:false};
  }

  const stops = [];
  for (const stop of input.stops) {
    const query = stop.query.trim();
    const alias = savedPlaceAlias(query);
    if (alias) {
      // Never send a private alias as a public Google text search.
      let saved, status = 'resolved', sourceVerified = false;
      try { saved = {placeId:privatePlaceIds[alias]??privatePlaces[alias]?.placeId}; }
      catch { status = 'saved_place_unavailable'; }
      if (status === 'resolved' && !saved) status = 'saved_place_missing';
      else if (status === 'resolved' && !isValidPlaceId(saved.placeId)) status = 'saved_place_refid_required';
      if (status === 'resolved') {
        try {
          await destinationCache.attestGooglePlaceIds(subject, [saved.placeId], PLACE_PROOF_TTL_SECONDS);
          sourceVerified = true;
        } catch { status = 'google_places_verification_unavailable'; }
      }
      stops.push({ query, alias, status, source: 'USER_CONFIRMED_ACCOUNT',
        candidates: [], ...(sourceVerified ? {selectedPlaceId: saved.placeId} : {}),
        more_candidates_possible: false, google_place_id_source_verified: sourceVerified,
        user_confirmed_alias: sourceVerified, place_identity_verified: false, cache_hit: true });
      continue;
    }
    const cached = await searchGoogle(query, { apiKey: apiKey.trim(), fetcher, destinationCache, subject });
    const result = cached.result;
    const rows = Array.isArray(result.candidates) ? result.candidates : [];
    const candidates = rows.filter(candidate => isValidPlaceId(candidate?.placeId) &&
      typeof candidate.name === 'string' && !!candidate.name.trim() && candidate.name.length <= 200 &&
      typeof candidate.address === 'string' && !!candidate.address.trim() && candidate.address.length <= 300);
    const malformedCandidates = candidates.length !== rows.length || rows.length > MAX_CANDIDATES ||
      new Set(candidates.map(candidate => candidate.placeId)).size !== candidates.length;
    let status = 'resolved';
    let selected = null;
    let sourceProofStored = false;

    if (result.reason) status = result.reason;
    else if (malformedCandidates) status = 'google_places_invalid_response';
    else if (!candidates.length) status = 'not_found';
    else {
      if (stop.selectedPlaceId !== undefined) {
        selected = candidates.find(candidate => candidate.placeId === stop.selectedPlaceId) ?? null;
        if (!selected) status = 'selection_invalid';
      } else if (candidates.length === 1 && result.more_candidates_possible !== true) {
        selected = candidates[0];
      } else status = 'needs_place_selection';

      // Attest only the unambiguous or explicitly selected ID. Search results
      // that still require a choice must never become trusted Tesla waypoints.
      if (status === 'resolved' && selected) {
        try {
          const age = Number.isFinite(cached.cache_age_seconds) ? Math.max(0, cached.cache_age_seconds) : 0;
          const proofTtl = Math.max(1, PLACE_PROOF_TTL_SECONDS - age);
          await destinationCache.attestGooglePlaceIds(subject, [selected.placeId], proofTtl);
          sourceProofStored = true;
        } catch {
          status = 'google_places_verification_unavailable';
          selected = null;
        }
      }
    }

    stops.push({
      query,
      status,
      source: 'GOOGLE_PLACES_API_NEW',
      candidates,
      ...(selected ? { selectedPlaceId: selected.placeId } : {}),
      more_candidates_possible: result.more_candidates_possible === true,
      google_place_id_source_verified: sourceProofStored,
      place_identity_verified: false,
      cache_hit: cached.cache_hit === true
    });
  }

  const failures = stops.filter(stop => stop.status !== 'resolved');
  if (failures.length) {
    const status = failures.some(stop => ['saved_place_missing', 'saved_place_refid_required', 'saved_place_unavailable'].includes(stop.status))
      ? 'needs_saved_place'
      : failures.some(stop => stop.status === 'needs_place_selection' || stop.status === 'selection_invalid')
      ? 'needs_place_selection'
      : failures.some(stop => stop.status === 'google_places_daily_limit') ? 'google_places_daily_limit'
        : failures.some(stop => stop.status.includes('unavailable') || stop.status.includes('invalid_response'))
          ? 'google_places_unavailable' : 'destination_not_found';
    return { status, attribution: 'Google Maps', stops, command_request: null,
      tesla_native_station_identity: 'not_resolved', sent_to_vehicle: false, dispatch_performed: false };
  }

  const waypoints = stops.map(stop => `refId:${stop.selectedPlaceId}`).join(',');
  if (waypoints.length > 2048) throw Error('invalid_map_arguments');
  return {
    status: 'payload_ready',
    attribution: 'Google Maps',
    place_id_namespace: 'google_places',
    tesla_native_station_identity: 'not_resolved',
    stops,
    command_request: { operation: 'navigation_waypoints_request', arguments: { waypoints } },
    sent_to_vehicle: false,
    dispatch_performed: false,
    note: 'Payload prepared but not sent. A Place ID identifies a Google point of interest; it does not verify semantic match, Tesla charging-site identity, or route acceptance and display on the vehicle.'
  };
}

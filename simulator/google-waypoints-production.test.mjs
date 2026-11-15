import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { destinationSearchCache } from './lib/destination-search-cache.mjs';
import { googlePlacesProductionEnabled, resolveWaypointPlaces } from './lib/google-waypoints.mjs';
import { prepareOperation } from './lib/operation-plans.mjs';
import { realMcp } from './lib/real-mcp.mjs';
import { TESLA_P256_ORIGIN } from './lib/partner-p256-identity.mjs';
import { request } from './offline-request.mjs';

const apiKey = 'server-only-test-key';
const configKey = { issuer: 'https://issuer.example/', key: Buffer.alloc(32, 23) };
const baseArgs = { externalMapsConsent: true, stops: [{ query: 'Supercharger Centralville' }, { query: 'Central Square' }] };
const place = (id, name, address) => ({ id, displayName: { text: name }, formattedAddress: address });

function harness({ responses = {}, quota = true, failQuota = false, failProofWrite = false } = {}) {
  const rows = new Map();
  let reservations = 0;
  const store = {
    get: async key => rows.get(key) ?? null,
    put: async (key, value) => { if (failProofWrite && key.startsWith('google-place-id-proof:')) throw Error('store'); rows.set(key, value); },
    reserveGooglePlacesRequest: async day => { reservations++; assert.match(day, /^\d{4}-\d{2}-\d{2}$/); if (failQuota) throw Error('store'); return quota; }
  };
  const destinationCache = destinationSearchCache({ store, config: configKey, now: () => Date.UTC(2026, 10, 8, 12) });
  const fetchCalls = [];
  const fetcher = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    const query = JSON.parse(options.body).textQuery;
    return Response.json(responses[query] ?? { places: [place('TESTPLACEIDONE00000000001', query, 'Italia')] });
  };
  return { destinationCache, fetcher, fetchCalls, get reservations() { return reservations; } };
}

test('Google resolver is production-only, uses a dedicated server key, and never falls back to the Demo key', () => {
  assert.equal(googlePlacesProductionEnabled({ VERCEL_ENV: 'preview', GOOGLE_PLACES_SEARCH_ENABLED: 'true', GOOGLE_PLACES_API_KEY: apiKey }), false);
  assert.equal(googlePlacesProductionEnabled({ VERCEL_ENV: 'production', GOOGLE_PLACES_API_KEY: apiKey }), false);
  assert.equal(googlePlacesProductionEnabled({ VERCEL_ENV: 'production', GOOGLE_PLACES_SEARCH_ENABLED: 'true', GOOGLE_PLACES_API_KEY: apiKey }), true);
  assert.equal(googlePlacesProductionEnabled({ VERCEL_ENV: 'production', GOOGLE_PLACES_SEARCH_ENABLED: 'true', GOOGLE_MAPS_DEMO_API_KEY: apiKey }), false);
  assert.equal(googlePlacesProductionEnabled({ VERCEL_ENV: 'production', GOOGLE_PLACES_SEARCH_ENABLED: 'true', GOOGLE_PLACES_API_KEY: apiKey, GOOGLE_MAPS_DEMO_API_KEY: apiKey }), false);
});

test('unique live-shaped Google responses yield one ordered multipoint payload and account-bound dynamic proof', async () => {
  const calls = harness({ responses: {
    'Supercharger Centralville': { places: [place('GoogleAlpha0001', 'Tesla Supercharger Centralville', 'Centralville, MI')] },
    'Central Square': { places: [place('GoogleBeta0001', 'Central Square', 'Milano, MI')] }
  } });
  const result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.status, 'payload_ready');
  assert.deepEqual(result.command_request, { operation: 'navigation_waypoints_request', arguments: {
    waypoints: 'refId:GoogleAlpha0001,refId:GoogleBeta0001'
  } });
  assert.equal(calls.fetchCalls.length, 2); assert.equal(calls.reservations, 2);
  assert.equal(result.sent_to_vehicle, false); assert.equal(result.dispatch_performed, false);
  assert.equal(result.tesla_native_station_identity, 'not_resolved');
  for (const call of calls.fetchCalls) {
    assert.equal(call.url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(call.options.headers['X-Goog-Api-Key'], apiKey);
    assert.equal(call.options.headers['X-Goog-FieldMask'], 'places.id,places.displayName,places.formattedAddress,nextPageToken');
    assert.equal(JSON.parse(call.options.body).pageSize, 5);
    assert.doesNotMatch(call.url + call.options.body, new RegExp(apiKey));
  }
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
  const ids = result.stops.map(stop => stop.selectedPlaceId);
  assert.deepEqual(await calls.destinationCache.verifyGooglePlaceIds('owner-a', ids), ids);
  assert.deepEqual(await calls.destinationCache.verifyGooglePlaceIds('owner-b', ids), []);
  assert.throws(() => prepareOperation('navigation_waypoints_request', result.command_request.arguments, { nativeWaypointsEnabled: true }), /place_id_unverified/);
  assert.doesNotThrow(() => prepareOperation('navigation_waypoints_request', result.command_request.arguments,
    { nativeWaypointsEnabled: true, googlePlacesVerifiedIds: ids }));
});

test('cached Google results reuse the proof and do not reserve another provider request', async () => {
  const calls = harness({ responses: { 'Supercharger Centralville': { places: [place('TESTPLACEIDONE00000000001', 'Tesla Supercharger Centralville', 'Centralville, MI')] } } });
  await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  const repeated = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(repeated.status, 'payload_ready');
  assert.equal(calls.fetchCalls.length, 2);
  assert.equal(calls.reservations, 2);
  assert.equal(repeated.stops.every(stop => stop.cache_hit), true);
});

test('multiple candidates and a next page require an explicit candidate selection', async () => {
  const ambiguous = harness({ responses: {
    'Supercharger Centralville': { places: [place('TESTPLACEIDONE00000000001', 'Supercharger Centralville', 'Centralville, MI'), place('ChIJo34equiVhkcRgdzTYOYkhoR', 'Supercharger Centralville 2', 'Milano, MI')] },
    'Central Square': { places: [place('TESTPLACEIDTWO00000000002', 'Central Square', 'Milano, MI')] }
  } });
  const unresolved = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: ambiguous.fetcher, destinationCache: ambiguous.destinationCache, subject: 'owner-a' });
  assert.equal(unresolved.status, 'needs_place_selection');
  assert.equal(unresolved.command_request, null);
  assert.equal(unresolved.stops[0].status, 'needs_place_selection');
  assert.equal(unresolved.stops[0].google_place_id_source_verified, false);
  assert.deepEqual(await ambiguous.destinationCache.verifyGooglePlaceIds('owner-a', [
    'TESTPLACEIDONE00000000001', 'ChIJo34equiVhkcRgdzTYOYkhoR'
  ]), []);
  assert.equal(unresolved.stops[0].place_identity_verified, false);

  const selected = await resolveWaypointPlaces({ ...baseArgs, stops: [
    { query: 'Supercharger Centralville', selectedPlaceId: 'ChIJo34equiVhkcRgdzTYOYkhoR' }, baseArgs.stops[1]
  ] }, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: ambiguous.fetcher, destinationCache: ambiguous.destinationCache, subject: 'owner-a' });
  assert.equal(selected.status, 'payload_ready');
  assert.match(selected.command_request.arguments.waypoints, /ChIJo34equiVhkcRgdzTYOYkhoR/);

  const paginated = harness({ responses: {
    'Supercharger Centralville': { places: [place('TESTPLACEIDONE00000000001', 'Supercharger Centralville', 'Centralville, MI')], nextPageToken: 'opaque-next-page' }
  } });
  const pageResult = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: paginated.fetcher, destinationCache: paginated.destinationCache, subject: 'owner-a' });
  assert.equal(pageResult.status, 'needs_place_selection');
  assert.equal(pageResult.stops[0].more_candidates_possible, true);
  assert.equal(pageResult.command_request, null);
  assert.doesNotMatch(JSON.stringify(pageResult), /opaque-next-page/);
});

test('unselected dynamic Google candidates cannot be reused in native waypoint commands', async () => {
  const chosenId = 'GoogleChosenPlace0001';
  const discardedId = 'GoogleDiscardedPlace0002';
  const landmarkId = 'GoogleLandmarkPlace0003';
  const calls = harness({ responses: {
    'Luogo ambiguo': { places: [
      place(chosenId, 'Luogo A', 'Milano, MI'),
      place(discardedId, 'Luogo B', 'Regionville, MB')
    ] },
    'Altro luogo': { places: [place(landmarkId, 'Luogo C', 'Laketown, CO')] }
  } });
  const input = { externalMapsConsent: true, stops: [{ query: 'Luogo ambiguo' }, { query: 'Altro luogo' }] };
  const options = { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' };
  const ambiguous = await resolveWaypointPlaces(input, options);
  assert.equal(ambiguous.status, 'needs_place_selection');
  assert.equal(ambiguous.command_request, null);
  assert.equal(ambiguous.stops[0].google_place_id_source_verified, false);
  assert.deepEqual(await calls.destinationCache.verifyGooglePlaceIds('owner-a', [chosenId, discardedId]), []);

  const selected = await resolveWaypointPlaces({ ...input, stops: [
    { query: 'Luogo ambiguo', selectedPlaceId: chosenId }, input.stops[1]
  ] }, options);
  assert.equal(selected.status, 'payload_ready');
  assert.equal(calls.fetchCalls.length, 2); // Selection uses cached search results.
  const trustedIds = await calls.destinationCache.verifyGooglePlaceIds('owner-a', [chosenId, discardedId, landmarkId]);
  assert.deepEqual(trustedIds, [chosenId, landmarkId]);
  assert.throws(() => prepareOperation('navigation_waypoints_request', {
    waypoints: `refId:${discardedId},refId:${landmarkId}`
  }, { nativeWaypointsEnabled: true, googlePlacesVerifiedIds: trustedIds }), /place_id_unverified/);
  assert.doesNotThrow(() => prepareOperation('navigation_waypoints_request',
    selected.command_request.arguments, { nativeWaypointsEnabled: true, googlePlacesVerifiedIds: trustedIds }));
});

test('quota exhaustion, quota storage failure, missing consent, disabled gates, and proof storage errors fail closed', async () => {
  let calls = harness({ quota: false });
  let result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.status, 'google_places_daily_limit'); assert.equal(calls.fetchCalls.length, 0);

  calls = harness({ failQuota: true });
  result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.status, 'google_places_unavailable'); assert.equal(calls.fetchCalls.length, 0);

  calls = harness({});
  await assert.rejects(resolveWaypointPlaces({ ...baseArgs, externalMapsConsent: false }, { apiKey, enabled: true,
    nativeWaypointsEnabled: true, fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' }), /invalid_map_arguments/);
  assert.equal(calls.fetchCalls.length, 0);
  result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: false, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.status, 'places_not_configured');
  result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: false,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.status, 'native_waypoints_disabled'); assert.equal(calls.fetchCalls.length, 0);

  calls = harness({ failProofWrite: true });
  result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.status, 'google_places_unavailable'); assert.equal(result.command_request, null);
});

test('invalid Google Place IDs and foreign selected IDs never produce a waypoint payload', async () => {
  let calls = harness({ responses: { 'Supercharger Centralville': { places: [place('not valid', 'Bad result', 'Bad address')] } } });
  let result = await resolveWaypointPlaces(baseArgs, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.command_request, null);
  assert.equal(result.status, 'google_places_unavailable');

  calls = harness({ responses: { 'Supercharger Centralville': { places: [place('TESTPLACEIDONE00000000001', 'Supercharger Centralville', 'Centralville, MI')] } } });
  result = await resolveWaypointPlaces({ ...baseArgs, stops: [
    { query: 'Supercharger Centralville', selectedPlaceId: 'TESTPLACEIDTWO00000000002' }, baseArgs.stops[1]
  ] }, { apiKey, enabled: true, nativeWaypointsEnabled: true,
    fetcher: calls.fetcher, destinationCache: calls.destinationCache, subject: 'owner-a' });
  assert.equal(result.command_request, null);
  assert.equal(result.stops[0].status, 'selection_invalid');
});

function mcpConfiguration({ googleEnabled = true } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'google-places-test-key', use: 'sig', alg: 'RS256' };
  const env = {
    APP_ORIGIN: TESLA_P256_ORIGIN, VERCEL_ENV: 'production', TESLA_READ_ENABLED: 'true', TESLA_LOCATION_ENABLED: 'true',
    MCP_ALLOWED_SUBJECT: 'google-test-user',
    TESLA_BACKEND_ENABLED: 'true', TESLA_COMMANDS_ENABLED: 'true', TESLA_COMMAND_EXECUTION_ENABLED: 'true',
    TESLA_REAL_RELEASE_APPROVED: 'true', TESLA_FLEET_REGION: 'eu', TESLA_NATIVE_WAYPOINTS_ENABLED: 'true',
    ...(googleEnabled ? { GOOGLE_PLACES_SEARCH_ENABLED: 'true', GOOGLE_PLACES_API_KEY: apiKey } : {})
  };
  const config = { origin: TESLA_P256_ORIGIN, issuer: 'https://issuer.example/', audience: `${TESLA_P256_ORIGIN}/mcp`,
    jwks: { keys: [jwk] }, env };
  const token = scope => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: config.issuer, aud: config.audience, sub: 'google-test-user',
      iat: now - 1, exp: now + 600, scope })).toString('base64url');
    return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
  };
  return { config, token };
}

test('Production MCP exposes Google resolver only behind all existing gates and requires authenticated location scope', async () => {
  const { config, token } = mcpConfiguration();
  let reservations = 0, providerCalls = 0;
  const destinationCache = {
    async resolve(subject, query, load) { return { result: await load(), cache_hit: false }; },
    async reserveGooglePlacesRequest() { reservations++; return true; },
    async attestGooglePlaceIds() { return 1; }
  };
  const backend = { destinationCache };
  const handler = realMcp({ config, backend });
  const provider = async () => { providerCalls++; return Response.json({ places: [place('TESTPLACEIDONE00000000001', 'One', 'Italy')] }); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = provider;
  try {
    const unauthorized = await handler(request('tools/call', { name: 'resolve_waypoint_places', arguments: baseArgs }, {}, `${config.origin}/mcp`));
    assert.equal(unauthorized.status, 401); assert.equal(reservations, 0); assert.equal(providerCalls, 0);

    const wrongScope = await handler(request('tools/call', { name: 'resolve_waypoint_places', arguments: baseArgs },
      { authorization: `Bearer ${token('battery:read')}` }, `${config.origin}/mcp`));
    assert.equal(wrongScope.status, 200);
    const denied = await wrongScope.json();
    assert.equal(JSON.parse(denied.result.content[0].text).error.required_scope, 'location:read');
    assert.equal(reservations, 0); assert.equal(providerCalls, 0);

    const allowed = await handler(request('tools/call', { name: 'resolve_waypoint_places', arguments: baseArgs },
      { authorization: `Bearer ${token('location:read')}` }, `${config.origin}/mcp`));
    assert.equal(allowed.status, 200);
    const success = await allowed.json();
    assert.equal(JSON.parse(success.result.content[0].text).status, 'payload_ready');
    assert.equal(reservations, 2); assert.equal(providerCalls, 2);
  } finally { globalThis.fetch = originalFetch; }

  const disabled = mcpConfiguration({ googleEnabled: false });
  let blockedRequests = 0;
  const disabledHandler = realMcp({ config: disabled.config, backend: { destinationCache: {
    async resolve() { blockedRequests++; }, async reserveGooglePlacesRequest() { blockedRequests++; return true; }, async attestGooglePlaceIds() { blockedRequests++; }
  } } });
  const hidden = await disabledHandler(request('tools/call', { name: 'resolve_waypoint_places', arguments: baseArgs },
    { authorization: `Bearer ${disabled.token('location:read')}` }, `${disabled.config.origin}/mcp`));
  assert.equal(hidden.status, 200); assert.equal(blockedRequests, 0);
  const hiddenBody = await hidden.json();
  assert.equal(hiddenBody.error?.code, -32602);
});


test('navigation-only plan_smart_trip in Production routes via Google Places without Photon, Tesla reads or dispatch',async()=>{
 const {config,token}=mcpConfiguration();
 let quota=0,googleCalls=0,proofWrites=0;
 const backend={
  destinationCache:{
   resolve:async (_subject,_query,load)=>({result:await load(),cache_hit:false}),
   reserveGooglePlacesRequest:async()=>{quota++;return true;},
   attestGooglePlaceIds:async()=>{proofWrites++;return 1;}
  },
  savedTripPlaces:{get:async()=>({places:{}})}
 };
 const handler=realMcp({config,backend});
 const prior=globalThis.fetch;
 globalThis.fetch=async(_url,init)=>{
   googleCalls++;
   const query=JSON.parse(init.body).textQuery;
   const id=query.includes('Example Square')?'GoogleGamma000001':query.includes('Centralville')?'GoogleAlpha000001':'GoogleBeta000001';
   return Response.json({places:[place(id,query,query+', Italia')]});
 };
 try{
  const args={navigationOnly:true,externalMapsConsent:true,stops:['Example Square, Eastville'],destination:'Central Square'};
  const response=await handler(request('tools/call',{name:'plan_smart_trip',arguments:args},
    {authorization:`Bearer ${token('battery:read location:read')}`},`${config.origin}/mcp`));
  assert.equal(response.status,200);
  const data=await response.json();
  const result=JSON.parse(data.result.content[0].text);
  assert.equal(result.status,'payload_ready');
  assert.equal(result.resolver_priority,'GOOGLE_PLACES');
  assert.equal(result.command_request.operation,'navigation_waypoints_request');
  assert.equal(result.command_request.arguments.waypoints,'refId:GoogleGamma000001,refId:GoogleBeta000001');
  assert.equal(result.sent_to_vehicle,false);assert.equal(result.automatic_dispatch,false);
  assert.equal(googleCalls,2);assert.equal(quota,2);assert.equal(proofWrites,2);

  // Named origin must remain first in the single native Google refId payload.
  const withOrigin=await handler(request('tools/call',{name:'plan_smart_trip',arguments:{
    navigationOnly:true,externalMapsConsent:true,
    origin:'Example Square, Eastville',stops:['Central Square'],destination:'Supercharger Centralville'
  }},{authorization:`Bearer ${token('battery:read location:read')}`},`${config.origin}/mcp`));
  assert.equal(withOrigin.status,200);
  const originResult=JSON.parse((await withOrigin.json()).result.content[0].text);
  assert.equal(originResult.status,'payload_ready');
  assert.equal(originResult.resolver_priority,'GOOGLE_PLACES');
  assert.equal(originResult.command_request.operation,'navigation_waypoints_request');
  assert.equal(originResult.command_request.arguments.waypoints,
    'refId:GoogleGamma000001,refId:GoogleBeta000001,refId:GoogleAlpha000001');
  assert.equal(originResult.sent_to_vehicle,false);

  // Alias not configured: no public search, no Tesla call, no quota use.
  const missing=await handler(request('tools/call',{name:'plan_smart_trip',arguments:{
    navigationOnly:true,externalMapsConsent:true,stops:['Example Square, Eastville'],destination:'Casa'
  }},{authorization:`Bearer ${token('battery:read location:read')}`},`${config.origin}/mcp`));
  const missingResult=JSON.parse((await missing.json()).result.content[0].text);
  assert.equal(missingResult.status,'needs_saved_place');assert.equal(missingResult.command_request,null);
  assert.equal(googleCalls,5);assert.equal(quota,5); // 2 original + 3 explicit-origin; missing alias adds zero
 }finally{globalThis.fetch=prior;}
});

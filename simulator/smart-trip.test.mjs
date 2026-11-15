import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingPreferences } from './lib/charging-preferences.mjs';
import { persistentStore } from './lib/store.mjs';
import { createTeslaBackend } from './lib/tesla.mjs';
import { planSmartTrip } from './lib/smart-trip.mjs';
import { planChargingRoadTrip } from './lib/charging-route.mjs';
import { computeNationalPlan } from './lib/national-routing.mjs';
import { chooseChargingPath } from './lib/charging-route.mjs';

const now = () => Date.parse('2026-11-04T12:00:00Z');
const timestamp = offset => new Date(now() + offset).toISOString();
const cached = { source: 'TESLA_CACHED', battery_percent: 39, observed_at: timestamp(-60_000) };
const milano = { lat: 45.4642, lon: 9.19 };
const hilltown = { lat: 46.4285, lon: 9.7636 };
const request = { destination: 'Hilltown/Segl', roundTrip: true, externalMapsConsent: true, teslaLocationConsent: true, teslaBatteryConsent: true };
const fail = () => assert.fail('unexpected operation');
const config = { issuer: 'https://issuer.invalid', key: Buffer.alloc(32, 7), env: {} };

function redisFixture() {
  const data = new Map();
  const store = persistentStore({ TOKEN_STORE_REST_URL: 'https://redis.invalid/', TOKEN_STORE_REST_TOKEN: 'fixture' }, async (url, init) => {
    assert.equal(new URL(url).hostname, 'redis.invalid');
    const [command, ...args] = JSON.parse(init.body);
    if (command === 'GET') return Response.json({ result: data.get(args[0]) ?? null });
    if (command === 'SET') {
      const [key, value, ...options] = args;
      if (options.includes('NX') && data.has(key)) return Response.json({ result: null });
      data.set(key, value); return Response.json({ result: 'OK' });
    }
    if (command === 'EVAL') {
      const [script, count, lock, keyOrOwner, owner, value] = args;
      if (count === 1 && data.get(lock) === keyOrOwner) { data.delete(lock); return Response.json({ result: 1 }); }
      if (count === 2 && data.get(lock) === owner) {
        assert.doesNotMatch(script, /'EX'/);
        data.set(keyOrOwner, value); return Response.json({ result: 1 });
      }
      return Response.json({ result: 0 });
    }
    return fail();
  });
  return { data, store };
}

function setup(patch = {}) {
  const calls = [];
  const backend = {
    preferences: { get: async () => ({ initialized: true, updated_at: timestamp(-1000),
      preferences: { consumptionKwhPer100Km: 13, chargingTargetPercent: 85 } }) },
    withTripReadLease: operation => operation(),
    vehicleReadingHistory: async () => ({ readings: [] }),
    battery: async () => { calls.push('battery'); return cached; },
    location: async () => { calls.push('location'); return { source: 'TESLA_LIVE', latitude: milano.lat, longitude: milano.lon, observed_at: timestamp(-1000) }; },
    ...patch
  };
  const maps = async () => ({ candidates: [{...hilltown,name:'Hilltown/Segl',city:'Hilltown/Segl',osm_key:'place',osm_value:'town'}] });
  const plan = async (args, options) => {
    calls.push('plan');
    assert.deepEqual(args.origin, milano);
    assert.equal(args.batteryPercent, 39);
    assert.equal(options.freeToXContract, undefined);
    assert.equal(args.consumptionKwhPer100Km, 13);
    return { charging_plan: { feasible: true }, sent_to_vehicle: false };
  };
  return { calls, deps: { backend, subject: 'owner', now, maps, plan } };
}

test('encrypted preferences persist across backend instances and isolate subject and issuer', async () => {
  const { store, data } = redisFixture();
  const make = issuer => chargingPreferences({ config: { ...config, issuer }, store, now });
  assert.equal((await make(config.issuer).get('owner')).initialized, false);
  await make(config.issuer).set('owner', { usableCapacityKwh: 68 });
  await make(config.issuer).set('owner', { efficiencyPercent: 90 });
  const record = await make(config.issuer).get('owner');
  assert.deepEqual(record.preferences, { usableCapacityKwh: 68, efficiencyPercent: 90 });
  assert.equal(record.updated_at, timestamp(0));
  assert.equal((await make(config.issuer).get('other')).preferences, null);
  assert.equal((await make('https://another.invalid').get('owner')).preferences, null);
  assert.doesNotMatch(JSON.stringify([...data]), /owner|freeToX|eurPerKwh/);
  await assert.rejects(make(config.issuer).set('owner', { freeToX: {} }), /invalid_charging_preferences/);
  assert.deepEqual(await make(config.issuer).get('owner'), record);
});

test('map consent uses a separate encrypted record',async()=>{
 const {store,data}=redisFixture();const prefs=chargingPreferences({config,store,now});
 await prefs.set('owner',{usableCapacityKwh:68});
 const initial=[...data.entries()][0]; assert.ok(initial);
 await prefs.set('owner',{chargingMapsConsent:true});
 assert.equal(data.get(initial[0]),initial[1]);
 assert.equal((await prefs.get('owner')).preferences.chargingMapsConsent,true);
 await prefs.set('owner',{chargingMapsConsent:false});
 assert.equal((await prefs.get('owner')).preferences.chargingMapsConsent,false);
 assert.equal(data.get(initial[0]),initial[1]);
});

test('default maximum is 85 and every explicit account maximum takes precedence',async()=>{
 for(const savedLimit of [undefined,80,90]){
  const {deps}=setup({location:fail,battery:fail,preferences:{get:async()=>({initialized:savedLimit!==undefined,preferences:savedLimit===undefined?null:{chargingTargetPercent:savedLimit}})}});
  const r=await planSmartTrip({origin:milano,destination:hilltown,batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},{...deps,maps:fail,plan:async args=>{
   assert.equal(args.chargingTargetPercent,savedLimit??85);return {charging_plan:{feasible:true}};
  }});
  assert.equal(r.status,'simulated_plan');
 }
});
test('saving reserve 82 uses default 85 while explicit saved maximum 80 still rejects it',async()=>{
 const {store}=redisFixture(),p=chargingPreferences({config,store,now});
 await p.set('new',{reservePercent:82});assert.equal((await p.get('new')).preferences.reservePercent,82);
 await p.set('existing',{chargingTargetPercent:80});
 await assert.rejects(p.set('existing',{reservePercent:82}),/invalid_charging_preferences/);
 assert.equal((await p.get('existing')).preferences.chargingTargetPercent,80);
});
test('station alternatives remain feasible without unverified pricing',async()=>{
 const stations=[{id:'ftx',operator:'Free To X',lat:45.5,lon:9.5,ccs2:true,power_kw:150,motorway_access:'reported'},
 {id:'other',operator:'Other',lat:45.51,lon:9.51,ccs2:true,power_kw:150}];
 const args={origin:milano,destination:hilltown,roundTrip:false,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,efficiencyPercent:95,objective:'cost',preferFreeToXMotorway:false};
 const r=await computeNationalPlan({input:args,catalog:{stations,countries:['IT']},line:[[9.19,45.4642],[9.5,45.5],[9.7636,46.4285]],
 maps:{routing:async()=>({distances:[[0,250000,80000,80000],[250000,0,172000,170000],[80000,172000,0,1000],[80000,170000,1000,0]]})},
 route:async points=>{const distances=[80000,points[1].id==='ftx'?172000:170000];return{distance:distances.reduce((a,b)=>a+b),duration:7200,legs:distances.map(distance=>({distance,duration:3600}))};},
 baseResult:{distance_km:250},choosePath:chooseChargingPath,estimate:()=>({})});
 assert.equal(r.charging_plan.feasible,true);
 assert.ok(['ftx','other'].includes(r.charging_plan.stops[0].id));
 assert.equal(r.charging_plan.estimated_cost_eur,null);
});
test('explicit account reserve conflict stops before GPS or SOC',async()=>{
 const {deps}=setup({preferences:{get:async()=>({preferences:{chargingTargetPercent:70}})},battery:fail,location:fail});
 assert.equal((await planSmartTrip({...request,reservePercent:75},deps)).status,'invalid_reserve_target');
});


test('automatic origin and recent cached SOC are sequenced with saved preferences', async () => {
  const { deps, calls } = setup();
  const result = await planSmartTrip(request, deps);
  assert.deepEqual(calls, ['battery', 'location', 'plan']);
  assert.equal(result.status, 'estimated_plan');
  assert.equal(result.battery.data_age_seconds, 60);
  assert.equal(result.battery.quality, 'tesla_cache');
  assert.equal(result.assumptions.usableCapacityKwh.source, 'planning_estimate');
  assert.equal(result.assumptions.consumptionKwhPer100Km.source, 'account_preference');
  assert.equal(result.sent_to_vehicle, false);
});

test('fresh app history avoids an API battery read', async () => {
  const { deps, calls } = setup({ vehicleReadingHistory: async () => ({ readings: [cached] }), battery: fail });
  assert.equal((await planSmartTrip(request, deps)).battery.quality, 'recent_app_cache');
  assert.deepEqual(calls, ['location', 'plan']);
});

test('obsolete SOC stops before GPS or routing', async () => {
  const { deps } = setup({ battery: async () => ({ ...cached, observed_at: timestamp(-16 * 60_000) }), location: fail });
  const result = await planSmartTrip(request, { ...deps, plan: fail });
  assert.equal(result.status, 'needs_fresh_soc');
  assert.equal(result.battery.quality, 'unusable_or_stale');
});

for (const reason of ['busy', 'vehicle_unavailable', 'budget']) {
  test(`one failed battery read (${reason}) produces no retry, GPS or itinerary`, async () => {
    let reads = 0;
    const { deps } = setup({ battery: async () => { reads++; throw Error(reason); }, location: fail });
    const result = await planSmartTrip({ ...request, batteryMode: 'live' }, { ...deps, plan: fail });
    assert.deepEqual(result, { status: 'vehicle_data_unavailable', stage: 'battery', reason, sent_to_vehicle: false });
    assert.equal(reads, 1);
  });
}

test('live failure uses history only with explicit fallback consent', async () => {
  const { deps } = setup({ vehicleReadingHistory: async () => ({ readings: [cached] }),
    battery: async () => { throw Error('vehicle_unavailable'); } });
  const result = await planSmartTrip({ ...request, batteryMode: 'live', allowCachedFallback: true }, deps);
  assert.equal(result.battery.quality, 'recent_app_cache_fallback');
  assert.equal(result.battery.source, 'TESLA_CACHED');
});

test('distributed lease rejects concurrent reads across backend instances', async () => {
  const { store } = redisFixture();
  const make = () => createTeslaBackend({ config, store, now, fetcher: fail });
  const firstBackend = make(), secondBackend = make();
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const { deps } = setup({ battery: async () => { reads++; started(); await gate; return cached; } });
  const first = planSmartTrip(request, { ...deps, backend: { ...deps.backend, withTripReadLease: firstBackend.withTripReadLease } });
  await entered;
  const second = await planSmartTrip(request, { ...deps, backend: { ...deps.backend, withTripReadLease: secondBackend.withTripReadLease } });
  assert.equal(second.reason, 'busy');
  release();
  await first;
  assert.equal(reads, 1);
});

test('missing consent and ambiguous geocoding do not touch vehicle or storage', async () => {
  const backend = new Proxy({}, { get(_target, property) {
    if (['destinationCache', 'acquirePublicGeocoderLease', 'tripPlans'].includes(property)) return undefined;
    return fail(property);
  } });
  assert.equal((await planSmartTrip({ ...request, teslaLocationConsent: false }, { backend, maps: fail })).status, 'needs_location_consent');
  assert.equal((await planSmartTrip({ ...request, teslaBatteryConsent: false }, { backend, maps: fail })).status, 'needs_battery_consent');
  const result = await planSmartTrip(request, { backend, maps: async () => ({ candidates: [hilltown,milano].map(p=>({...p,name:'Hilltown/Segl',city:'Hilltown/Segl',osm_key:'place',osm_value:'town'})) }) });
  assert.equal(result.status, 'needs_place_selection');
  assert.equal(result.places[0].candidates.length, 2);
});

test('zero map matches are reported as not found without an ambiguity prompt, while provider outages are explicit',async()=>{
 const tripPlans={saveDraft:async()=>({id:'D'.repeat(43),expires_at:new Date(now()+900000).toISOString()})},backend={tripPlans};
 const noMatch=await planSmartTrip({origin:milano,destination:'Punto senza corrispondenza',batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},
  {subject:'owner',now,backend,maps:async()=>({source:'PHOTON_OSM',provider_calls:1,fallback_status:'no_match',candidates:[]}),plan:fail});
 assert.equal(noMatch.status,'destination_not_found');assert.equal(noMatch.places[0].reason,'no_map_match');
 assert.equal(noMatch.places[0].candidates.length,0);assert.equal(noMatch.map_metrics.clarification_count,0);assert.equal(noMatch.continuation_state_saved,true);
 const unavailable=await planSmartTrip({origin:milano,destination:'Laketown',batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},
  {subject:'owner',now,backend,maps:async()=>({source:'PHOTON_OSM',provider_calls:1,fallback_status:'rate_limiter_unavailable',candidates:[]}),plan:fail});
 assert.equal(unavailable.status,'maps_unavailable');assert.equal(unavailable.places[0].reason,'map_provider_unavailable');
 assert.equal(unavailable.map_metrics.clarification_count,0);
});

test('map timeouts and partial charging data never certify a definitive plan', async () => {
  const { deps } = setup();
  assert.equal((await planSmartTrip(request, { ...deps, maps: async () => { throw Error('map_provider_unavailable'); } })).status, 'maps_unavailable');
  const result = await planSmartTrip(request, { ...deps, plan: async () => ({
    charging_plan: { feasible: null }, station_data: { coverage_complete: false }
  }) });
  assert.equal(result.status, 'charging_unverified');
  assert.equal(result.itinerary.station_data.coverage_complete, false);
});

// Sparse road replay extracted from docs/evidence/route-mcp-acceptance-20261104.json.
const evidence = {
  "munich": {
    "distance_km": 495.9662,
    "legs": [
      {
        "distance_km": 0.7701,
        "duration_minutes": 2.493333333333333
      },
      {
        "distance_km": 229.6816,
        "duration_minutes": 181.52666666666667
      },
      {
        "distance_km": 265.5145,
        "duration_minutes": 173.16
      }
    ],
    "stops": [
      {
        "id": "IT*A2M*E12202051570006*1A",
        "lat": 45.458453,
        "lon": 9.191695,
        "operator": "A2A E.MOBILITY S.R.L.",
        "ccs2": true,
        "power_kw": 50
      },
      {
        "id": "CH*GFS*E*Mia*1",
        "lat": 46.9196457,
        "lon": 9.5628865,
        "operator": "Energie 360 Grad AG",
        "ccs2": true,
        "power_kw": 300
      }
    ]
  },
  "paris": {
    "distance_km": 859.1598,
    "legs": [
      {
        "distance_km": 0.7701,
        "duration_minutes": 2.493333333333333
      },
      {
        "distance_km": 236.3736,
        "duration_minutes": 177.43833333333333
      },
      {
        "distance_km": 307.7086,
        "duration_minutes": 198.51333333333332
      },
      {
        "distance_km": 314.3075,
        "duration_minutes": 201.66333333333333
      }
    ],
    "stops": [
      {
        "id": "IT*A2M*E12202051570006*1A",
        "lat": 45.458453,
        "lon": 9.191695,
        "operator": "A2A E.MOBILITY S.R.L.",
        "ccs2": true,
        "power_kw": 50
      },
      {
        "id": "FREBNEBTUDM2",
        "lat": 45.9015,
        "lon": 6.86026,
        "operator": "EASYCHARGE",
        "ccs2": true,
        "power_kw": 50
      },
      {
        "id": "FRFR1EAXTM1",
        "lat": 47.021884,
        "lon": 4.873812,
        "operator": "Freshmile | FR*FR1",
        "ccs2": true,
        "power_kw": 24
      }
    ]
  },
  "hilltown": {
    "distance_km": 327.6274,
    "legs": [
      {
        "distance_km": 54.8054,
        "duration_minutes": 58.02333333333333
      },
      {
        "distance_km": 106.50739999999999,
        "duration_minutes": 114.83999999999999
      },
      {
        "distance_km": 166.3146,
        "duration_minutes": 172.02333333333334
      }
    ],
    "stops": [
      {
        "id": "IT*A0C*E12006005400005*1A",
        "lat": 45.850473,
        "lon": 9.39382,
        "operator": "A2A E.MOBILITY S.R.L.",
        "ccs2": true,
        "power_kw": 50
      }
    ]
  }
};
const cities = { hilltown, munich: { lat: 48.137, lon: 11.575 }, paris: { lat: 48.857, lon: 2.352 } };
for (const [key, destination] of Object.entries(cities)) {
  test(`Milano to ${key}: replays recorded road legs through orchestrator, matrix search and optimizer`, async () => {
    const saved = evidence[key], roundTrip = key === 'hilltown';
    const stations = saved.stops.map(stop => ({ ...stop, ccs2: true }));
    const coordinate = p => p.lon + ',' + p.lat;
    const legs = saved.legs.map(l => ({ distance: l.distance_km * 1000, duration: l.duration_minutes * 60 }));
    const itinerary = [milano, ...stations, destination, ...(roundTrip ? [milano] : [])];
    const road = new Map(itinerary.slice(1).map((p, i) => [coordinate(itinerary[i]) + '/' + coordinate(p), legs[i]]));
    // Sparse replay: only distances present in the historical fixture are certified.
    const fetcher = async url => {
      const pathname = new URL(url).pathname;
      const points = pathname.split('/').at(-1).split(';');
      if (pathname.includes('/table/')) return Response.json({ code: 'Ok',
        distances: points.map(a => points.map(b => a === b ? 0 : road.get(a + '/' + b)?.distance ?? null)) });
      if (pathname.includes('/route/')) {
        const actual = points.length === itinerary.length ? points.slice(1).map((p, i) => road.get(points[i] + '/' + p))
          : (roundTrip ? [{ distance: 161000, duration: 8000 }, { distance: 167000, duration: 9000 }]
            : [{ distance: saved.distance_km * 1000, duration: 9000 }]);
        if (actual.some(l => !l)) return new Response(null, { status: 503 });
        return Response.json({ code: 'Ok', routes: [{ legs: actual, distance: actual.reduce((a, l) => a + l.distance, 0),
          duration: actual.reduce((a, l) => a + l.duration, 0), geometry: { coordinates: itinerary.map(p => [p.lon, p.lat]) } }] });
      }
      return fail();
    };
    const { deps } = setup({ location: fail, battery: fail });
    const result = await planSmartTrip({ origin: milano, destination, roundTrip, externalMapsConsent: true,
      batteryPercent: 39, simulatedBattery: true }, { ...deps, maps: fail, plan: (args, options) =>
      planChargingRoadTrip(args, { ...options, fetcher, stationCatalog: { stations, countries: ['IT'], sources: [{ country: 'IT', status: 'ok', download_complete: false }] } }) });
    assert.equal(result.status, 'simulated_plan');
    assert.equal(result.battery.source, 'SIMULATED');
    assert.equal(result.itinerary.charging_plan.stops.length, stations.length);
    assert.ok(result.itinerary.legs.every(l => l.reserve_met && l.arrival_kwh >= 10.2));
    assert.equal(result.itinerary.charging_plan.estimated_cost_eur, null);
    assert.equal(result.itinerary.station_data.coverage_complete, false);
  });
}

test('round trip preserves ordered waypoints even when charging is required', async () => {
  const waypoint = { lat: 45.5, lon: 9.5 }, station = { lat: 45.7, lon: 9.7, ccs2: true, power_kw: 150, operator: 'Free To X' };
  const matrix = [[0,null,20000,null],[80000,0,null,null],[null,null,0,35000],[null,120000,null,0]];
  let routed;
  const fetcher = async url => {
    const pathname = new URL(url).pathname;
    if (pathname.includes('/table/')) return Response.json({ code: 'Ok', distances: matrix });
    const points = pathname.split('/').at(-1).split(';');
    if (points.length === 5) routed = points;
    const legs = (points.length === 5 ? [20000,35000,120000,80000] : [20000,155000,80000]).map(distance => ({ distance, duration: 100 }));
    return Response.json({ code: 'Ok', routes: [{ legs, distance: legs.reduce((a, l) => a + l.distance, 0), duration: legs.length * 100,
      geometry: { coordinates: [[milano.lon,milano.lat],[waypoint.lon,waypoint.lat],[station.lon,station.lat],[hilltown.lon,hilltown.lat],[milano.lon,milano.lat]] } }] });
  };
  const { deps } = setup();
  const result = await planSmartTrip({ ...request, stops: [waypoint] }, { ...deps, plan: (args, options) =>
    planChargingRoadTrip(args, { ...options, fetcher, stationCatalog: { stations: [station], countries: ['IT'] } }) });
  assert.equal(result.status, 'estimated_plan');
  assert.deepEqual(routed, [milano, waypoint, station, hilltown, milano].map(p => p.lon + ',' + p.lat));
  assert.equal(result.itinerary.charging_plan.stops[0].tariff_mode, null);
  assert.deepEqual(result.navigation.ordered_destinations, [waypoint, station, hilltown, milano].map(p => ({lat:p.lat,lon:p.lon})));
  assert.equal(result.navigation.automatic_dispatch, false);
  assert.deepEqual(result.itinerary.navigation_handoff.next_destination, waypoint);
  assert.equal(result.itinerary.charging_plan.estimated_cost_eur, null);
});


for (const count of [2,3,4]) test('navigationOnly resolves '+count+' ordered places through Photon/OSM without Tesla reads or charging planning',async()=>{
 const placeNames=Array.from({length:count},(_,i)=>'POI voce '+i);
 if(count===4)placeNames[count-1]='Casa';
 const mapCalls=[],stored={};
 const pointFor=i=>({lat:45.5+i/100,lon:9.1+i/100});
 const {deps:{backend}}=setup({
  preferences:{get:async()=>{throw Error('navigation-only must not read preferences');}},
  battery:async()=>{throw Error('navigation-only must not read battery');},
  location:async()=>{throw Error('navigation-only must not read Tesla location');},
  withTripReadLease:async()=>{throw Error('navigation-only must not acquire Tesla read lease');},
  savedTripPlaces:{get:async()=>({places:{home:{lat:46,lon:10}},source:'USER_CONFIRMED_ACCOUNT'})},
  tripPlans:{
   save:async(_owner,plan)=>{stored.plan=plan;return{id:'M'.repeat(43),multi_stop_candidate_available:true};},
   get:async()=>({multi_stop_navigation_handoff:{available:true,command_request:{
    operation:'navigation_gps_request',arguments:{points:stored.plan.destinations}},api_actuation_count:count}})
  }
 });
 const result=await planSmartTrip({stops:placeNames.slice(0,-1),destination:placeNames.at(-1),
  navigationOnly:true,externalMapsConsent:true,routePreferences:{avoidHighways:true,avoidTolls:true}},
  {subject:'owner',now,backend,maps:async(_name,{query})=>{
    mapCalls.push(query);
    const index=placeNames.indexOf(query);
    const coords=pointFor(index);
    return {source:'PHOTON_OSM',provider_calls:1,candidates:[{
      ...coords,name:query,city:'Lombardia',country:'Italia',osm_key:'amenity',osm_value:'charging_station',
      osm_id:500+index,osm_type:'node',source_url:'https://www.openstreetmap.org/node/'+(500+index),source:'PHOTON_OSM',
      ...(query.startsWith('Ewiva')?{operator:'Ewiva',brand:'Ewiva',street:'SP35 dei Giovi'}:{})
    }]};
  },plan:async()=>{throw Error('navigation-only must not invoke energy/routing planner');}});
 assert.equal(result.status,'multipoint_candidate_prepared');
 assert.equal(result.sent_to_vehicle,false);
 assert.equal(result.ordered_destinations.length,count);
 assert.deepEqual(result.ordered_destinations.map(p=>p.name),placeNames);
 assert.deepEqual(result.navigation.handoff.command_request.arguments.points,stored.plan.destinations);
 assert.equal(stored.plan.navigation_only,true);
 assert.deepEqual(stored.plan.resolved_route.stops,placeNames.slice(0,-1));
 assert.equal(stored.plan.resolved_route.destination,placeNames.at(-1));
 assert.equal(mapCalls.includes('Casa'),false);
 assert.equal(mapCalls.length,count-(count===4?1:0));
 assert.equal(result.routing_preferences.applied_to_tesla,false);
 assert.equal(result.routing_preferences.router_applied,false);
 assert.equal(result.navigation.automatic_dispatch,false);
});

test('navigationOnly rejects one, five or non-name destinations before map/vehicle access',async()=>{
 let maps=0,vehicle=0;
 const {deps:{backend}}=setup({preferences:{get:async()=>{vehicle++;throw Error('unexpected');}}});
 for(const names of [['one'],['1','2','3','4','5'],['1',{lat:45.5,lon:9.1}]]){
  const result=await planSmartTrip({stops:names.slice(0,-1),destination:names.at(-1),
    navigationOnly:true,externalMapsConsent:true},{subject:'owner',now,backend,
    maps:async()=>{maps++;throw Error('unexpected');},plan:async()=>{throw Error('unexpected');}});
  assert.equal(result.status,'invalid_navigation_route');
 }
 assert.equal(maps,0);assert.equal(vehicle,0);
});

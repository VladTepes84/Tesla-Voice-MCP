import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeRoadTrip, roadTripTools } from './lib/road-trip.mjs';
import { requiredToolScope } from './lib/mcp-tool-auth.mjs';
const origin = { lat: 45, lon: 9 }, destination = { lat: 46, lon: 10 };
const input = { origin, destination, roundTrip: true, batteryPercent: 70, usableCapacityKwh: 68, consumptionKwhPer100Km: 20, reservePercent: 15, externalMapsConsent: true };
test('reverse geocoding returns street and mapped civic candidate without exposing coordinates', async () => {
  const r = await invokeRoadTrip('reverse_trip_location',{center:origin,externalMapsConsent:true},{fetcher:async url => {
    assert.equal(new URL(url).pathname,'/reverse');
    return Response.json({features:[{geometry:{coordinates:[9,45]},properties:{street:'Via Scenario Fittizio',housenumber:'12',city:'Citta Esempio',country:'Italia'}}]});
  }});
  assert.equal(r.spoken_address,'Via Scenario Fittizio 12, Citta Esempio, Italia');
  assert.equal(r.exact_address_verified,false);
  assert.doesNotMatch(JSON.stringify(r),/latitude|longitude|coordinates/);
});
test('reverse geocoding never invents a civic number and rejects distant map matches', async () => {
  const run = (coordinates, properties) => invokeRoadTrip('reverse_trip_location',{center:origin,externalMapsConsent:true},{fetcher:async()=>Response.json({features:[{geometry:{coordinates},properties}]})});
  const street = await run([9,45],{street:'Via Scenario Fittizio',city:'Citta Esempio'});
  assert.equal(street.house_number,null); assert.equal(street.precision,'street');
  const far = await run([10,46],{street:'Wrong street',housenumber:'99'});
  assert.equal(far.address_available,false); assert.equal(far.reason,'no_nearby_map_match');
});
test('map tools require location scope and explicit consent before outbound traffic', async () => {
  for (const t of roadTripTools) {
    assert.equal(requiredToolScope(t.name), 'location:read');
    await assert.rejects(invokeRoadTrip(t.name, {}, { fetcher: () => { throw Error('must not fetch'); } }), /map_consent_required/);
  }
});
test('ambiguous geocoding retains candidates and country instead of choosing a destination', async () => {
  const r = await invokeRoadTrip('search_trip_destination', { query: 'Hilltown', externalMapsConsent: true }, { fetcher: async (url, opts) => {
    assert.equal(new URL(url).hostname, 'photon.komoot.io'); assert.equal(opts.redirect, 'error');
    return Response.json({ features: [1, 2].map(i => ({ geometry: { coordinates: [9+i, 46] }, properties: { name: 'Hilltown', country: 'Switzerland' } })) });
  } });
  assert.equal(r.selection_required, true); assert.equal(r.candidates.length, 2);
});
test('unknown names are sent unchanged without a preconfigured personal alias', async () => {
 const query='Example Centre, Exampleville'; let observed;
 const r=await invokeRoadTrip('search_trip_destination',{query,externalMapsConsent:true},{fetcher:async url=>{
  observed=new URL(url).searchParams.get('q'); return Response.json({features:[]});
 }});
 assert.equal(observed,query); assert.deepEqual(r.candidates,[]);
});
test('round trip uses actual road legs including return and reports energy deficit', async () => {
  const r = await invokeRoadTrip('plan_road_trip', input, { fetcher: async url => {
    assert.match(url, /9,45;10,46;9,45/);
    return Response.json({ code: 'Ok', routes: [{ distance: 400000, duration: 18000, legs: [{ distance: 190000, duration: 8500 }, { distance: 210000, duration: 9500 }] }] });
  } });
  assert.equal(r.distance_km, 400); assert.equal(r.legs.length, 2);
  assert.equal(r.energy.required_kwh, 80); assert.ok(r.energy.minimum_additional_battery_kwh > 0);
  assert.equal(r.sent_to_vehicle, false); assert.equal(r.tariffs_verified, false);
});
test('bad coordinates, extra URL fields and missing capacity are rejected before network', async () => {
  for (const v of [{ ...input, origin: { lat: NaN, lon: 9 } }, { ...input, url: 'https://evil.invalid' }, { ...input, usableCapacityKwh: undefined }])
    await assert.rejects(invokeRoadTrip('plan_road_trip', v, { fetcher: () => { assert.fail('network'); } }));
});
test('provider errors are safe and attempts are bounded to two providers', async () => {
  let calls = 0;
  await assert.rejects(invokeRoadTrip('plan_road_trip', input, { fetcher: async () => { calls++; throw Error('private URL'); } }), /^Error: map_provider_unavailable$/);
  assert.equal(calls, 2);
});
test('legacy charging-site call defaults to national DC, with unknown prices and occupancy', async()=>{
 const r=await invokeRoadTrip('find_charging_sites',{center:origin,radiusKm:5,externalMapsConsent:true},{
  fetcher:()=>assert.fail('Overpass or network called'),catalogLoader:async args=>{
   assert.equal(args.includeAc,false);
   return {stations:[{id:'test',lat:45,lon:9,ccs2:true,connectorType:'CCS2',operator:'Free To X',availability:'unknown',tariff:null,source_url:'https://official.invalid/data'}],sources:[{country:'IT',status:'ok',download_complete:false}]};
  }});
 assert.equal(r.sites[0].operator,'Free To X');assert.equal(r.sites[0].tariff,null);assert.equal(r.sites[0].availability,'unknown');
 assert.equal(r.connector_type,'CCS2');assert.equal(r.execution_evidence.tool,'find_charging_sites');assert.equal(r.coverage_complete,false);
});

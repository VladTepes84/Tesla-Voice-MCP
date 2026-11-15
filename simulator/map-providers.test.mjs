import test from 'node:test';
import assert from 'node:assert/strict';
import { mapClient, routePreferenceExclusions } from './lib/map-providers.mjs';
import { planChargingRoadTrip } from './lib/charging-route.mjs';
import previewHealth from './api/preview-health.mjs';

test('the fixed map acceptance fixture is unavailable in Production', async()=>{
  const previous=process.env.VERCEL_ENV;
  process.env.VERCEL_ENV='production';
  try {
    for (const fixture of ['milano-hilltown','osm-verona']) {
      const response=await previewHealth.fetch(new Request('https://example.invalid/diagnostics/oauth-preview?map-test='+fixture));
      assert.equal(response.status,404);
    }
  } finally {
    if(previous===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous;
  }
});

test('routing fails over malformed data and caches validated data without leaking request locations', async () => {
  const calls=[];
  const fetcher=async (url,opts)=>{
    calls.push(url); assert.equal(opts.redirect,'error'); assert.ok(opts.signal);
    return Response.json(calls.length===1?{bad:true}:{distance:123});
  };
  const maps=mapClient(fetcher);
  assert.equal((await maps.routing('/route/test',d=>d.distance===123)).distance,123);
  assert.match(calls[1],/^https:\/\/routing.openstreetmap.de\/routed-car\//);
  await mapClient(fetcher).routing('/route/test',d=>d.distance===123);
  assert.equal(calls.length,2);
  assert.equal(JSON.stringify(maps.diagnostics).includes('/route/test'),false);
});

test('429 respects backpressure without immediately retrying another mirror', async () => {
  let calls=0;
  const maps=mapClient(async()=>{calls++; return new Response('',{status:429});});
  await assert.rejects(maps.charging('test'),/map_provider_unavailable/);
  assert.equal(calls,1); assert.equal(maps.diagnostics[0].outcome,'rate_limited');
  await assert.rejects(maps.charging('test'),/map_provider_unavailable/);
  assert.equal(calls,1);
});

test('identical concurrent map requests are coalesced', async () => {
  let calls=0;
  const maps=mapClient(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Response.json({ok:true});});
  await Promise.all([maps.routing('/same'),maps.routing('/same')]);
  assert.equal(calls,1);
});

test('requested no-motorway/toll preferences become OSRM class exclusions without claiming Tesla application',async()=>{
 const points='9,45;9.1,45.1';let called=0;
 const maps=mapClient(async url=>{
  called++;
  const parsed=new URL(url);
  assert.equal(parsed.hostname,'router.project-osrm.org');
  assert.equal(parsed.searchParams.get('exclude'),'motorway,toll');
  return Response.json({code:'Ok',routes:[{distance:1000,duration:100,legs:[{distance:1000,duration:100}]}]});
 },{routePreferences:{avoidHighways:true,avoidTolls:true,preferredRoads:['SS35 dei Giovi']}});
 await maps.routing(`/route/v1/driving/${points}?overview=false`,data=>data.code==='Ok');
 const report=maps.routePreferenceReport();
 assert.equal(called,1);assert.deepEqual(routePreferenceExclusions({avoidMotorways:true,avoidTolls:true}),['motorway','toll']);
 assert.deepEqual(report.excluded_osrm_classes,['motorway','toll']);assert.equal(report.planner_query_applied,true);
 assert.deepEqual(report.unsupported_preferences,['preferredRoads']);assert.equal(report.applied_to_tesla,false);
 assert.equal(report.real_world_avoidance_verified,false);
});

const input={origin:{lat:45.4642,lon:9.19},destination:{lat:46.4285,lon:9.7636},roundTrip:true,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,externalMapsConsent:true};
const road={code:'Ok',routes:[{distance:327177.8,duration:20594.4,legs:[{distance:160863.2,duration:10273},{distance:166314.6,duration:10321.4}],geometry:{coordinates:[[9.19,45.4642],[9.7636,46.4285],[9.19,45.4642]]}}]};
test('charging outage preserves real road distance and energy without inventing a feasible stop', async()=>{
  let routing=0,charging=0;
  const result=await planChargingRoadTrip(input,{fetcher:async url=>{
    if(url.includes('/route/')){routing++;return Response.json(road);}
    charging++;throw Error('sensitive upstream message');
  }});
  assert.equal(routing,1);assert.equal(charging,2);
  assert.equal(result.distance_km,327.1778);
  assert.ok(Math.abs(result.energy.required_kwh-42.533114)<1e-8);
  assert.equal(result.charging_plan.feasible,null);
  assert.equal(result.charging_data_available,false);
  assert.equal(JSON.stringify(result).includes('sensitive'),false);
});
test('an empty successful CCS2 search remains distinct from provider failure', async()=>{
  const result=await planChargingRoadTrip(input,{fetcher:async url=>Response.json(url.includes('/route/')?road:{elements:[]})});
  assert.equal(result.charging_data_available,true);
  assert.equal(result.charging_plan.reason,'no_mapped_ccs2_sites');
  assert.equal(result.distance_km,327.1778);
});
test('CCS2 results outside the road corridor are not proposed as roadside stops', async()=>{
  const result=await planChargingRoadTrip(input,{fetcher:async url=>Response.json(url.includes('/route/')?road:{elements:[{type:'node',id:123,lat:45.5,lon:10.5,tags:{'socket:type2_combo':'yes'}}]})});
  assert.equal(result.charging_plan.reason,'no_mapped_ccs2_sites');
});
test('matrix outage still returns mapped chargers without claiming feasible stops', async()=>{
  const result=await planChargingRoadTrip(input,{fetcher:async url=>{
    if(url.includes('/route/'))return Response.json(road);
    if(url.includes('/table/'))throw Error('offline');
    return Response.json({elements:[{type:'node',id:123,lat:45.4642,lon:9.19,tags:{'socket:type2_combo':'yes'}}]});
  }});
  assert.equal(result.charging_data_available,true);
  assert.equal(result.sites.length,1);
  assert.equal(result.charging_plan.feasible,null);
});

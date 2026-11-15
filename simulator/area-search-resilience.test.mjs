import test from 'node:test';import assert from 'node:assert/strict';
import {invokeRoadTrip} from './lib/road-trip.mjs';
import {IT_SHARDS} from './lib/italian-stations.mjs';
const args={center:{lat:46.135,lon:9.37},radiusKm:12,externalMapsConsent:true};
test('SS36 municipalities include Colico, Piantedo and Chiavenna official shards',()=>{
 for(const id of ['097023','014048','014018'])assert.ok(IT_SHARDS.includes(id));
});
test('missing connector keeps the old connector schema usable and excludes AC without Overpass',async()=>{
 const r=await invokeRoadTrip('find_charging_sites',args,{fetcher:()=>assert.fail('network'),catalogLoader:async()=>({stations:[{id:'dc',lat:46.14,lon:9.38,ccs2:true},{id:'ac',lat:46.14,lon:9.38,ccs2:false,connectorType:'AC'},{id:'far',lat:45,lon:9,ccs2:true}],sources:[{country:'IT',status:'ok',download_complete:false}]})});
 assert.deepEqual(r.sites.map(s=>s.id),['dc']);assert.equal(r.search_status,'partial_results');assert.ok(r.execution_evidence.execution_reference);assert.equal(r.sent_to_vehicle,false);
});
test('all providers unavailable is explicit, never a successful empty-station assertion',async()=>{
 const r=await invokeRoadTrip('find_charging_sites',args,{catalogLoader:async()=>({stations:[],sources:[{country:'IT',status:'unavailable',reason:'feed_timeout'}]})});
 assert.equal(r.search_status,'sources_unavailable');assert.equal(r.coverage_complete,false);assert.deepEqual(r.sites,[]);assert.equal(r.sources[0].reason,'feed_timeout');
});
test('no matches in a partial catalog is distinct from provider failure and proves no absence',async()=>{
 const r=await invokeRoadTrip('find_charging_sites',args,{catalogLoader:async()=>({stations:[],sources:[{country:'IT',status:'ok',download_complete:false}]})});
 assert.equal(r.search_status,'no_matches_in_partial_catalog');assert.match(r.limitation,/do not prove absence/);
});
test('invalid connector fails before catalogs; execution log excludes input coordinates',async t=>{
 await assert.rejects(invokeRoadTrip('find_charging_sites',{...args,connectorType:'CHAdeMO'},{catalogLoader:()=>assert.fail('provider')}),/invalid_map_arguments/);
 const old=console.info,logs=[];console.info=(...v)=>logs.push(v);t.after(()=>{console.info=old;});
 const r=await invokeRoadTrip('find_charging_sites',args,{catalogLoader:async()=>({stations:[],sources:[]})});
 assert.equal(logs[0][0],'CHARGING_AREA_SEARCH');assert.equal(JSON.parse(logs[0][1]).execution_reference,r.execution_evidence.execution_reference);
 assert.doesNotMatch(JSON.stringify(logs),/46\.135|9\.37|center|radius/);
});

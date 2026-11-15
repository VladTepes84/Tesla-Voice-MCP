import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOsmCharging, osmAreaQuery } from './lib/osm-charging.mjs';
import { invokeRoadTrip } from './lib/road-trip.mjs';
import { planChargingRoadTrip } from './lib/charging-route.mjs';

const data={elements:[
 {type:'node',id:10,lat:45.44,lon:10.99,tags:{amenity:'charging_station',operator:'Example','socket:type2':'2','socket:type2_combo':'1'}},
 {type:'node',id:11,lat:45.44,lon:10.99,tags:{access:'private','socket:type2_combo':'1'}},
 {type:'node',id:12,lat:45.44,lon:10.99,tags:{'socket:type2_combo':'0'}},
 {type:'node',id:13,lat:45.44,lon:10.99,tags:{'socket:chademo':'1'}}
]};
test('OSM network and brand are preserved without assuming a price',()=>{
 for(const identity of [{network:'Tesla'},{brand:'Tesla'}]){
  const [station]=normalizeOsmCharging({elements:[{type:'node',id:42,lat:45,lon:9,tags:{operator:'Example',...identity,'socket:type2_combo':'1'}}]});
  assert.equal(station.tariff,null);
 }
});
test('OSM data distinguishes AC and CCS2 and excludes private or unavailable connectors',()=>{
 const stations=normalizeOsmCharging(data,{includeAc:true});
 assert.deepEqual(stations.map(s=>s.connectorType),['CCS2','AC','DC']);
 assert.ok(stations.every(s=>s.availability==='unknown'&&s.tariff===null));
 assert.throws(()=>normalizeOsmCharging({elements:[],remark:'timeout'}));
 assert.match(osmAreaQuery({lat:45.44,lon:10.99},5),/around:5000/);
});
for(const connectorType of ['AC','CCS2','DC'])test('area search includes OSM '+connectorType+' beyond national shards',async()=>{
 const result=await invokeRoadTrip('find_charging_sites',{center:{lat:45.44,lon:10.99},radiusKm:5,connectorType,externalMapsConsent:true},
  {catalogLoader:async()=>({stations:[],sources:[{country:'IT',status:'ok'}]}),osmCharging:async()=>data});
 assert.equal(result.sites.length,connectorType==='DC'?2:1);assert.equal(result.sites[0].source,'OPENSTREETMAP');
 assert.ok(result.sites.some(site=>site.connectorType===connectorType));assert.equal(result.coverage_complete,false);
});
test('failed OSM preserves national results and reports failure',async()=>{
 const result=await invokeRoadTrip('find_charging_sites',{center:{lat:45.44,lon:10.99},radiusKm:5,externalMapsConsent:true},
  {catalogLoader:async()=>({stations:[{id:'national',lat:45.44,lon:10.99,ccs2:true}],sources:[]}),osmCharging:async()=>{throw Error('timeout');}});
 assert.equal(result.sites[0].id,'national');assert.equal(result.sources.at(-1).status,'unavailable');
});
test('road trip can find an OSM CCS2 stop outside national catalogs',async()=>{
 const fetcher=async url=>{
  if(String(url).includes('/table/'))return Response.json({code:'Ok',distances:[[0,200000,50000],[200000,0,150000],[50000,150000,0]]});
  const legs=String(url).includes('9.5,45.5')?[50000,150000]:[200000];
  return Response.json({code:'Ok',routes:[{distance:200000,duration:7200,legs:legs.map(distance=>({distance,duration:3600})),geometry:{coordinates:[[9,45],[9.5,45.5],[10,46]]}}]});
 };
 const result=await planChargingRoadTrip({origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:false,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:20,reservePercent:15,chargingTargetPercent:85,maxChargingStops:4,externalMapsConsent:true,efficiencyPercent:90},
  {fetcher,stationCatalog:{stations:[],sources:[],countries:[]},osmCharging:async()=>({elements:[{type:'node',id:42,lat:45.5,lon:9.5,tags:{operator:'Other operator',network:'Tesla','socket:type2_combo':'1'}}]})});
 assert.equal(result.charging_plan.feasible,true);assert.equal(result.charging_plan.stops[0].source,'OPENSTREETMAP');assert.equal(result.sent_to_vehicle,false);
 assert.equal(result.charging_plan.stops[0].estimated_cost_eur,null);
});

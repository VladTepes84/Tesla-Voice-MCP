import test from 'node:test';import assert from 'node:assert/strict';
import {deadlineFetcher,withinDeadline} from './lib/request-deadline.mjs';
import {loadEuropeanStations,loadGermanStations} from './lib/european-stations.mjs';
import {planChargingRoadTrip} from './lib/charging-route.mjs';
const input={origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:false,batteryPercent:39,batterySource:'simulated',usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,externalMapsConsent:true};
const swiss={EVSEData:[{OperatorName:'Fixture',EVSEDataRecord:[{EvseID:'CH*FIX*1',Accessibility:'Free publicly accessible',GeoCoordinates:{Google:'45.5 9.5'},Plugs:['CCS Combo 2 Plug (Cable Attached)'],ChargingFacilities:[{power:150,powertype:'DC'}]}]}]};
const hang=()=>new Promise(()=>{});
test('absolute deadline bounds provider ignoring abort and body reads that never settle',async()=>{
 let started=Date.now();await assert.rejects(deadlineFetcher(hang,Date.now()+40)('https://example.invalid'),{name:'TimeoutError'});assert.ok(Date.now()-started<500);
 const fetcher=async()=>new Response(new ReadableStream({pull(){return hang();}}));
 const r=await deadlineFetcher(fetcher,Date.now()+40)('https://example.invalid');
 await assert.rejects(r.body.getReader().read(),{name:'TimeoutError'});
});
test('cold all-source failure returns an empty honest catalog within budget',async()=>{
 const started=Date.now(),c=await loadEuropeanStations({fetcher:hang,deadline:Date.now()+60});
 assert.equal(c.stations.length,0);assert.equal(c.sources.length,4);assert.equal(c.coverage_complete,false);
 assert.ok(c.sources.every(s=>s.status==='unavailable'));assert.ok(Date.now()-started<500);
});
test('cold planner retains Swiss rows, reports two timeouts, verifies road legs on first attempt',async()=>{
 const fetcher=async(url)=>{
 if(url.includes('data.geo.admin.ch'))return Response.json(swiss);
 if(url.includes('bundesnetzagentur')||url.includes('data.gouv.fr'))return hang();
 if(url.includes('/table/'))return Response.json({code:'Ok',distances:[[0,200000,50000],[200000,0,150000],[50000,150000,0]]});
 const values=url.includes('9.5,45.5')?[50000,150000]:[200000];
 return Response.json({code:'Ok',routes:[{distance:200000,duration:7200,geometry:{coordinates:[[9,45],[9.5,45.5],[10,46]]},legs:values.map(distance=>({distance,duration:3600}))}]});
 };
 const started=Date.now(),r=await planChargingRoadTrip(input,{fetcher,catalogLoader:loadEuropeanStations,budgetMs:4500,catalogBudgetMs:80});
 assert.equal(r.charging_plan.feasible,true);assert.equal(r.station_data.coverage_complete,false);
 assert.ok(r.diagnostics.some(d=>d.stage==='catalog'&&d.country==='DE'&&d.outcome==='unavailable'));
 assert.ok(r.charging_plan.legs.every(l=>l.reserve_met));assert.ok(Date.now()-started<4500);
});
test('all slow catalogs preserve computed road instead of timing out the function',async()=>{
 let routing=0;
 const fetcher=async url=>{if(url.includes('/route/')){routing++;return Response.json({code:'Ok',routes:[{distance:200000,duration:7200,geometry:{coordinates:[[9,45],[10,46]]},legs:[{distance:200000,duration:7200}]}]});}return hang();};
 const r=await planChargingRoadTrip(input,{fetcher,catalogLoader:loadEuropeanStations,budgetMs:5500,catalogBudgetMs:60});
 assert.equal(r.charging_data_available,false);assert.equal(r.distance_km,200);assert.equal(r.charging_plan.feasible,null);assert.equal(r.station_data.sources.length,4);assert.equal(routing,1);
});
test('German source budget spans metadata and CSV; only complete rows survive stalled tail',async()=>{
 const header='Betreiber;Breitengrad;Längengrad;Status;Steckertypen1;Nennleistung Stecker1;EVSE-ID1\n';
 const row='Fixture;48;10;In Betrieb;DC Fahrzeugkupplung Typ Combo 2 (CCS);150;DE*FIX*1\n';
 const fetcher=async url=>{
 if(url.includes('DownloadundKontakt'))return new Response('<a href="https://data.bundesnetzagentur.de/Bundesnetzagentur/test.csv">csv</a>');
 let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode(header+row+'incomplete'));}else return hang();}}));
 };
 const started=Date.now(),r=await loadGermanStations({fetcher,deadline:Date.now()+60});
 assert.equal(r.stations.length,1);assert.equal(r.complete,false);assert.equal(r.issue,'partial_download_timeout');assert.ok(Date.now()-started<500);
});
test('expired deadline cannot restart routing fallback or await another request indefinitely',async()=>{
 let calls=0;
 await assert.rejects(withinDeadline(()=>{calls++;return hang();},Date.now()-1),{name:'TimeoutError'});assert.equal(calls,0);
});

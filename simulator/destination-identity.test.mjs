import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDestinationCandidates} from './lib/destination-resolution.mjs';
import {invokeRoadTrip} from './lib/road-trip.mjs';
import {planSmartTrip} from './lib/smart-trip.mjs';
const poi=(city,patch={})=>({lat:45.5,lon:9.1,name:'Il Gigante',city,country:'Italy',osm_key:'shop',osm_value:'supermarket',...patch});
const fail=()=>assert.fail('Unexpected vehicle/maps/storage');
test('explicit municipality cannot be replaced by a sole commercial POI in another town',async()=>{
 for(const query of ['Il Gigante di Cormano','Il Gigante Cormano','Il Gigante, Cormano','Il Gigante a Cormano']){
  assert.deepEqual(resolveDestinationCandidates(query,[poi('Desio')]),[]);
  assert.deepEqual(resolveDestinationCandidates(query,[poi('')]),[]);
  assert.equal(resolveDestinationCandidates(query,[poi('Desio'),poi('Cormano')])[0].city,'Cormano');
  const r=await planSmartTrip({origin:{lat:45,lon:9},destination:query,batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},{subject:'fixture',backend:{destinationCache:null,acquirePublicGeocoderLease:null},maps:async()=>({source:'PHOTON_OSM',candidates:[poi('Desio')]}),plan:fail});
  assert.equal(r.status,'destination_not_found');assert.equal(r.places[0].reason,'no_map_match');assert.equal(r.sent_to_vehicle,false);
 }
});
test('destination text is preserved and Nominatim fallback uses an injected lease',async()=>{
 const seen=[];let released=0;
 const result=await invokeRoadTrip('search_trip_destination',{query:'Via Sample 40, Laketown',externalMapsConsent:true},{
  nominatimPermit:async()=>({release:async()=>{released++;}}),
  fetcher:async url=>{
   const parsed=new URL(url);seen.push(parsed);
   if(parsed.hostname==='photon.komoot.io')return Response.json({features:[]});
   return Response.json([{lat:'45.808',lon:'9.085',name:'Via Sample 40',osm_type:'way',osm_id:987654,address:{road:'Via Sample',house_number:'40',city:'Laketown',state:'Lombardia',country:'Italia'}}]);
  }
 });
 assert.equal(seen.length,2);assert.equal(seen[0].searchParams.get('q'),'Via Sample 40, Laketown');
 assert.equal(seen[1].hostname,'nominatim.openstreetmap.org');assert.equal(released,1);
 assert.equal(result.source,'NOMINATIM_OSM');assert.equal(result.selection_required,false);
 assert.equal(result.query_correction,undefined);assert.equal(result.candidates[0].house_number,'40');
});
test('Nominatim is never queried without a distributed provider lease',async()=>{
 let calls=0;
 const result=await invokeRoadTrip('search_trip_destination',{query:'A place with no map result',externalMapsConsent:true},{fetcher:async()=>{calls++;return Response.json({features:[]});}});
 assert.equal(calls,1);assert.equal(result.candidates.length,0);assert.equal(result.provider_calls,1);
});
test('Nominatim is a bounded fallback when Photon is unavailable',async()=>{
 let released=0;const calls=[];
 const result=await invokeRoadTrip('search_trip_destination',{query:'Laketown',externalMapsConsent:true},{
  nominatimPermit:async()=>({release:async()=>{released++;}}),
  fetcher:async url=>{const parsed=new URL(url);calls.push(parsed.hostname);
   if(parsed.hostname==='photon.komoot.io')throw Error('offline');
   return Response.json([{lat:'45.808',lon:'9.085',name:'Laketown',osm_type:'relation',osm_id:123,address:{city:'Laketown',state:'Lombardia',country:'Italia'}}]);}
 });
 assert.deepEqual(calls,['photon.komoot.io','nominatim.openstreetmap.org']);assert.equal(released,1);
 assert.equal(result.source,'NOMINATIM_OSM');assert.equal(result.fallback_status,'matched');assert.equal(result.provider_calls,2);
});
test('missing house number may resolve to an explicitly estimated street segment, never another civic number',async()=>{
 let calls=0,released=0;
 const result=await invokeRoadTrip('search_trip_destination',{query:'Via Sample 40, Laketown',externalMapsConsent:true},{
  nominatimPermit:async()=>({release:async()=>{released++;}}),
  fetcher:async url=>{
   calls++;const parsed=new URL(url);
   if(parsed.hostname==='nominatim.openstreetmap.org')return Response.json([]);
   if(parsed.searchParams.get('q')==='Via Sample, Laketown')return Response.json({features:[{geometry:{coordinates:[9.085,45.808]},properties:{name:'Via Sample',city:'Laketown',state:'Lombardia',country:'Italia',osm_key:'highway',osm_value:'residential',osm_type:'W',osm_id:8811}}]});
   return Response.json({features:[]});
  }
 });
 assert.equal(calls,3);assert.equal(released,1);assert.equal(result.selection_required,false);
 assert.equal(result.address_precision,'street_segment_estimate');assert.equal(result.candidates[0].house_number,'');
 const wrong=await invokeRoadTrip('search_trip_destination',{query:'Via Sample 40, Laketown',externalMapsConsent:true},{
  nominatimPermit:async()=>({release:async()=>{}}),fetcher:async url=>{
   const parsed=new URL(url);if(parsed.hostname==='nominatim.openstreetmap.org')return Response.json([]);
   return parsed.searchParams.get('q')==='Via Sample, Laketown'?Response.json({features:[{geometry:{coordinates:[9.085,45.808]},properties:{name:'Via Sample 39',street:'Via Sample',housenumber:'39',city:'Laketown',country:'Italia',osm_key:'building',osm_value:'yes',osm_type:'W',osm_id:8812}}]}):Response.json({features:[]});
  }
 });
 assert.equal(wrong.candidates.length,0);
});
test('known distinct OSM identities do not disappear through proximity deduplication',()=>{
 const candidates=[poi('Cormano',{osm_type:'N',osm_id:10}),poi('Cormano',{osm_type:'N',osm_id:11,lat:45.50001})];
 assert.equal(resolveDestinationCandidates('Il Gigante, Cormano',candidates).length,2);
});
test('verified street and house metadata survive and support a qualified address',async()=>{
 const r=await invokeRoadTrip('search_trip_destination',{query:'Via Roma 12, Cormano, Italia',externalMapsConsent:true},{fetcher:async()=>Response.json({features:[{geometry:{coordinates:[9.1,45.5]},properties:{street:'Via Roma',housenumber:'12',city:'Cormano',country:'Italy',osm_key:'building',osm_value:'yes'}}]})});
 assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].house_number,'12');assert.equal(r.selection_required,false);
});
test('commercial POI and address qualifiers match all mapped fields and reject a different civic number',()=>{
 const mapped=poi('Cormano',{street:'Via Roma',house_number:'12'});
 assert.deepEqual(resolveDestinationCandidates('Il Gigante, Via Roma 12, Cormano, Italia',[mapped]),[mapped]);
 assert.deepEqual(resolveDestinationCandidates('Il Gigante, Via Roma 13, Cormano, Italia',[mapped]),[]);
});
test('smart trip accepts the exact curated POI alias and preserves the unverified-address note',async()=>{
 const candidate={...poi('Exampleville',{name:'Example Sports Centre',street:'Via Example',osm_key:'leisure',osm_value:'sports_centre',osm_type:'W',osm_id:12345678}),matched_alias:'Examplecentre Exampleville',house_number_verified:false,entrance_verified:false};
 const note='Civico 60 e ingresso esatto non verificati.';
 let routed;
 const result=await planSmartTrip({origin:{lat:45.5,lon:9.1},destination:'Examplecentre Exampleville, Via Example 60',batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},{
  subject:'fixture',backend:{preferences:{get:async()=>({initialized:false,preferences:{}})}},
  maps:async(name,args)=>{assert.equal(name,'search_trip_destination');assert.equal(args.query,'Examplecentre Exampleville, Via Example 60');return {query_resolution:'verified_public_poi_alias',selection_required:false,candidates:[candidate],note};},
  plan:async args=>{routed=args.destination;return {charging_plan:{feasible:true},navigation_destinations:[args.destination]};}
 });
 assert.equal(result.sent_to_vehicle,false);
 assert.equal(result.status,'simulated_plan');
 assert.deepEqual(routed,{lat:45.5,lon:9.1});
 assert.equal(result.destination_resolution_notes[0].query,'Examplecentre Exampleville, Via Example 60');
 assert.equal(result.destination_resolution_notes[0].note,note);
});
test('private home aliases never become public geocoding queries, even with map consent',async()=>{
 for(const query of ['Casa','HOME','a casa','casa mia','la mia casa']){
  const r=await invokeRoadTrip('search_trip_destination',{query,externalMapsConsent:true},{fetcher:fail});
  assert.equal(r.external_query_performed,false);assert.equal(r.candidates.length,0);
  const p=await planSmartTrip({origin:{lat:45,lon:9},destination:query,batteryPercent:39,simulatedBattery:true,externalMapsConsent:true},{subject:'fixture',backend:{},maps:fail,plan:fail});
  assert.equal(p.status,'needs_saved_place');assert.equal(p.places[0].alias,'home');
 }
});

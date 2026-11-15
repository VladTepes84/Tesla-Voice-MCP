import test from 'node:test';
import assert from 'node:assert/strict';
import {savedPlaceAlias,savedTripPlaces} from './lib/saved-trip-places.mjs';
import {resolveWaypointPlaces} from './lib/google-waypoints.mjs';

const placeId='GoogleHomeVerified001', workId='GoogleWorkVerified001';
const config={issuer:'https://issuer.example/',key:Buffer.alloc(32,9)};
function fixture(){
 const values=new Map();let proofAllowed=false;
 const store={
  get:async key=>values.get(key)??null,
  lock:async key=>({savePermanent:async value=>values.set(key,value),release:async()=>{}})
 };
 const aliases=savedTripPlaces({config,store,now:()=>Date.parse('2026-11-09T07:00:00Z'),
  verifyGooglePlaceIds:async(_subject,ids)=>proofAllowed?ids:[]});
 return {aliases,allowProof:()=>{proofAllowed=true;}};
}

test('Casa and Lavoro aliases are independent, encrypted, account-scoped and explicitly confirmed',async()=>{
 const f=fixture();
 assert.equal(savedPlaceAlias('a casa'),'home');
 assert.equal(savedPlaceAlias('in ufficio'),'work');
 assert.equal(savedPlaceAlias('Milano Duomo'),null);
 assert.deepEqual((await f.aliases.get('owner')).places,{});
 await f.aliases.set('owner',{alias:'home',point:{lat:45.6,lon:9.2},confirmedByUser:true});
 await f.aliases.set('owner',{alias:'work',point:{lat:45.4,lon:9.1},confirmedByUser:true});
 assert.deepEqual(Object.keys((await f.aliases.get('owner')).places).sort(),['home','work']);
 assert.deepEqual((await f.aliases.get('other-owner')).places,{});
 await f.aliases.set('owner',{alias:'home',point:null,confirmedByUser:true});
 assert.deepEqual(Object.keys((await f.aliases.get('owner')).places),['work']);
 await assert.rejects(f.aliases.set('owner',{alias:'work',point:{lat:45.5,lon:9.2},confirmedByUser:false}),/invalid_arguments/);
});

test('Google Place ID alias requires existing account proof before durable save',async()=>{
 const f=fixture();
 await assert.rejects(f.aliases.set('owner',{alias:'home',point:{placeId},confirmedByUser:true}),/place_id_unverified/);
 assert.deepEqual((await f.aliases.get('owner')).places,{});
 f.allowProof();
 const saved=await f.aliases.set('owner',{alias:'home',point:{placeId},confirmedByUser:true});
 assert.equal(saved.reference_type,'user_confirmed_google_place_id');
 assert.deepEqual((await f.aliases.get('owner')).places.home,{placeId});
 assert.deepEqual((await f.aliases.get('another')).places,{});
 await f.aliases.set('owner',{alias:'work',point:{placeId:workId},confirmedByUser:true});
 assert.deepEqual(Object.keys((await f.aliases.get('owner')).places).sort(),['home','work']);
});

test('one confirmed alias can retain coordinates and a verified Place ID for both planners',async()=>{
 const f=fixture();f.allowProof();
 const coordinates={lat:45.6,lon:9.2};
 const saved=await f.aliases.set('owner',{alias:'home',point:{coordinates,placeId},confirmedByUser:true});
 assert.equal(saved.reference_type,'user_confirmed_coordinates_and_google_place_id');
 const result=await f.aliases.get('owner');
 assert.deepEqual(result.places.home,coordinates);
 assert.equal(result.google_place_ids.home,placeId);
});

function resolver({places={},google_place_ids={}}={}){
 let calls=0, quota=0, proofs=[];
 const destinationCache={
  resolve:async(_subject,_query,load)=>({result:await load(),cache_hit:false}),
  reserveGooglePlacesRequest:async()=>{quota++;return true;},
  attestGooglePlaceIds:async(_subject,ids)=>{proofs.push(...ids);return ids.length;}
 };
 const fetcher=async (_url,options)=>{
  calls++;
  const query=JSON.parse(options.body).textQuery;
  return Response.json({places:[{id:'GoogleBetaVerified001',displayName:{text:query},formattedAddress:'Milano, Italia'}]});
 };
 return {destinationCache,fetcher,savedTripPlaces:{get:async()=>({places,google_place_ids})},get calls(){return calls;},get quota(){return quota;},get proofs(){return proofs;}};
}
const opts=x=>({apiKey:'fake-test-only',enabled:true,nativeWaypointsEnabled:true,subject:'owner',
 destinationCache:x.destinationCache,fetcher:x.fetcher,savedTripPlaces:x.savedTripPlaces});
test('missing or coordinate-only private alias blocks before public Google calls, preserving daily quota',async()=>{
 for(const places of [{},{home:{lat:45.6,lon:9.2}}]){
  const f=resolver({places});
  const r=await resolveWaypointPlaces({externalMapsConsent:true,stops:[{query:'Central Square'},{query:'Casa'}]},opts(f));
  assert.equal(r.status,'needs_saved_place');
  assert.equal(r.command_request,null);
  assert.equal(f.calls,0);assert.equal(f.quota,0);
 }
});
test('confirmed private Place ID joins public Google destination in one atomic prepared request without alias disclosure',async()=>{
 const f=resolver({places:{home:{placeId}}});
 const r=await resolveWaypointPlaces({externalMapsConsent:true,stops:[{query:'Central Square'},{query:'Casa'}]},opts(f));
 assert.equal(r.status,'payload_ready');
 assert.deepEqual(r.command_request,{operation:'navigation_waypoints_request',arguments:{waypoints:'refId:GoogleBetaVerified001,refId:'+placeId}});
 assert.equal(f.calls,1);assert.equal(f.quota,1);assert.equal(r.sent_to_vehicle,false);
 assert.deepEqual(f.proofs,['GoogleBetaVerified001',placeId]);
 assert.equal(r.stops[1].source,'USER_CONFIRMED_ACCOUNT');
});
test('dual-reference private alias uses its Google ID for native waypoints',async()=>{
 const coordinates={lat:45.6,lon:9.2};
 const f=resolver({places:{home:coordinates},google_place_ids:{home:placeId}});
 const r=await resolveWaypointPlaces({externalMapsConsent:true,stops:[{query:'Central Square'},{query:'Casa'}]},opts(f));
 assert.equal(r.status,'payload_ready');
 assert.match(r.command_request.arguments.waypoints,new RegExp(`refId:${placeId}$`));
 assert.equal(f.calls,1);assert.equal(f.quota,1);
});

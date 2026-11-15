import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveFrequentWaypoints} from './lib/frequent-waypoints.mjs';
import {prepareOperation} from './lib/operation-plans.mjs';
const names=['Example One','Example Two','Example Three'];
const sampleCatalog=names.map((name,i)=>({name,aliases:i===0?['First']:[],lat:45+i,lng:9,placeId:'TESTPLACE_'+i,placeIdVerified:i!==1,placeIdSource:'https://fixture.invalid/'}));
test('disabled native gate never falls back to experimental coordinates and does not send',()=>{
 const result=resolveFrequentWaypoints(names,{coordinateWaypointsEnabled:true,catalog:sampleCatalog});
 assert.equal(result.status,'native_waypoints_disabled');
 assert.equal(result.command_request,null);
 assert.equal(result.sent_to_vehicle,false);
});
test('missing names, disabled gate and unverified IDs fail closed',()=>{
 assert.equal(resolveFrequentWaypoints(['First','non esiste'],{nativeWaypointsEnabled:true,catalog:sampleCatalog}).status,'destination_not_found');
 assert.equal(resolveFrequentWaypoints(names,{catalog:sampleCatalog}).status,'native_waypoints_disabled');
 const result=resolveFrequentWaypoints(names,{nativeWaypointsEnabled:true,catalog:sampleCatalog});
 assert.equal(result.status,'place_id_unverified');assert.equal(result.command_request,null);
 assert.throws(()=>resolveFrequentWaypoints(['Centralville']),/invalid_arguments/);
});
test('verified test fixture IDs produce one refId list in the requested order',()=>{
 const catalog=names.map((name,i)=>({name,aliases:[],lat:45+i,lng:9,source:'fixture',placeId:'TESTPLACE_'+i,placeIdVerified:true,placeIdSource:'https://verification.fixture.invalid/places/'+i}));
 const result=resolveFrequentWaypoints(names,{nativeWaypointsEnabled:true,catalog});
 assert.equal(result.command_request.arguments.waypoints,'refId:TESTPLACE_0,refId:TESTPLACE_1,refId:TESTPLACE_2');
 assert.deepEqual(result.destinations.map(x=>x.name),names);
 assert.equal(result.sent_to_vehicle,false);
 assert.doesNotThrow(()=>prepareOperation('navigation_waypoints_request',result.command_request.arguments,{nativeWaypointsEnabled:true,verifiedWaypointPlaceIds:catalog.map(x=>x.placeId)}));
 assert.throws(()=>prepareOperation('navigation_waypoints_request',result.command_request.arguments,{nativeWaypointsEnabled:true}),/place_id_unverified/);
});
test('two, three, four, and sixteen stops each produce one ordered multipoint request in isolated fixtures',()=>{
 for(const size of [2,3,4,16]){
  const ordered=Array.from({length:size},(_,i)=>`Tappa ${i+1}`);
  const catalog=ordered.map((name,i)=>({name,aliases:[],lat:45+i/100,lng:9,placeId:`SYNTHETIC${String(i).padStart(4,'0')}`,
   placeIdVerified:true,placeIdSource:`https://fixture.invalid/${i}`}));
  const prepared=resolveFrequentWaypoints(ordered,{nativeWaypointsEnabled:true,catalog});
  assert.equal(prepared.command_request.operation,'navigation_waypoints_request');
  assert.equal(prepared.command_request.arguments.waypoints,catalog.map(row=>'refId:'+row.placeId).join(','));
  assert.equal(prepared.command_request.arguments.waypoints.split(',').length,size);
  assert.equal(prepared.dispatch_performed,false);assert.equal(prepared.sent_to_vehicle,false);
 }
});
test('C — Ewiva then Laketown builds exactly one ordered two-stop refId command in a synthetic fixture',()=>{
 const catalog=[
  {name:'Example Charger',aliases:['Ewiva Exampletown'],placeId:'SYNTHETICEWIVA01',placeIdVerified:true,placeIdSource:'https://fixture.invalid/ewiva'},
  {name:'Via Sample 40, Laketown',aliases:['Via Sample Laketown'],placeId:'SYNTHETICCOMO001',placeIdVerified:true,placeIdSource:'https://fixture.invalid/laketown'}
 ];
 const prepared=resolveFrequentWaypoints(['Ewiva Exampletown','Via Sample Laketown'],{nativeWaypointsEnabled:true,catalog});
 assert.deepEqual(prepared.command_request,{operation:'navigation_waypoints_request',arguments:{waypoints:'refId:SYNTHETICEWIVA01,refId:SYNTHETICCOMO001'}});
 assert.equal(prepared.dispatch_performed,false);assert.equal(prepared.sent_to_vehicle,false);
});
test('a fresh installation contains no preconfigured personal destinations',()=>{
 assert.equal(resolveFrequentWaypoints(['Unknown One','Unknown Two'],{nativeWaypointsEnabled:true}).status,'destination_not_found');
});
test('every resolver entry needs a verified ID and HTTPS source',()=>{
 const catalog=names.map((name,i)=>({name,aliases:[],placeId:'TESTPLACE_'+i,placeIdVerified:true,placeIdSource:'https://verification.fixture.invalid/'+i}));
 catalog[1]={...catalog[1],placeIdVerified:false};
 const result=resolveFrequentWaypoints(names,{nativeWaypointsEnabled:true,catalog});
 assert.equal(result.status,'place_id_unverified');
 assert.deepEqual(result.missing,['Example Two']);
 catalog[1]={...catalog[1],placeIdVerified:true,placeIdSource:'not-a-url'};
 assert.equal(resolveFrequentWaypoints(names,{nativeWaypointsEnabled:true,catalog}).status,'place_id_unverified');
});

test('private destination configuration accepts only bounded valid catalogs', async () => {
 const { parseFrequentDestinationCatalog } = await import('./lib/frequent-waypoint-catalog.mjs');
 const catalog = parseFrequentDestinationCatalog(JSON.stringify([{name:'Example',aliases:['A'],placeId:'SYNTHETIC001',placeIdVerified:true,placeIdSource:'https://example.invalid/'}]));
 assert.equal(catalog[0].name,'Example');
 for (const value of ['not json','{}','[{"name":"Example","aliases":[3]}]',JSON.stringify(Array(101).fill({name:'X',aliases:[]}))])
  assert.throws(()=>parseFrequentDestinationCatalog(value),/invalid_frequent_destinations_configuration/);
});

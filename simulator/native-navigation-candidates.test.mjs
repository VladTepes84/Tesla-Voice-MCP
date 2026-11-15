import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeNavigationEnabled,parseNativeCoordinates,nativeStationSelections,NATIVE_COORDINATE_SCHEMA,NATIVE_SC_SCHEMA} from './lib/native-navigation-candidates.mjs';
import {TESLA_P256_ORIGIN} from './lib/partner-p256-identity.mjs';
import {prepareOperation} from './lib/operation-plans.mjs';
import {tripNavigation} from './lib/trip-navigation.mjs';
const config={origin:TESLA_P256_ORIGIN,issuer:'fixture',key:Buffer.alloc(32,7),env:{APP_ORIGIN:TESLA_P256_ORIGIN,TESLA_VEHICLE_VIN:'5YJ3E1EA0LF000000',VERCEL_ENV:'production',TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',TESLA_NATIVE_COORDINATE_ENABLED:'true',TESLA_NATIVE_COORDINATE_PILOT_ENABLED:'true',TESLA_NATIVE_COORDINATE_SCHEMA:NATIVE_COORDINATE_SCHEMA,TESLA_NATIVE_SUPERCHARGER_ENABLED:'true',TESLA_NATIVE_SUPERCHARGER_SCHEMA:NATIVE_SC_SCHEMA}};
test('native activation requires explicit matching schema plus all existing production conditions',()=>{
 for(const kind of ['coordinates','supercharger']){
  assert.equal(nativeNavigationEnabled(config,kind),true);assert.equal(nativeNavigationEnabled({env:{}},kind),false);
  if(kind==='coordinates')assert.equal(nativeNavigationEnabled({...config,env:{...config.env,TESLA_NATIVE_COORDINATE_PILOT_ENABLED:undefined}},kind),false);
  for(const field of ['TESLA_READ_ENABLED','TESLA_BACKEND_ENABLED','TESLA_COMMANDS_ENABLED','TESLA_COMMAND_EXECUTION_ENABLED','TESLA_REAL_RELEASE_APPROVED'])assert.equal(nativeNavigationEnabled({...config,env:{...config.env,[field]:'false'}},kind),false);
  assert.equal(nativeNavigationEnabled({...config,origin:'https://preview.invalid'},kind),false);assert.equal(nativeNavigationEnabled({...config,env:{...config.env,VERCEL_ENV:'preview'}},kind),false);
  const schema=kind==='coordinates'?'TESLA_NATIVE_COORDINATE_SCHEMA':'TESLA_NATIVE_SUPERCHARGER_SCHEMA';assert.equal(nativeNavigationEnabled({...config,env:{...config.env,[schema]:'guess'}},kind),false);
 }
});
test('coordinate parser validates the entire list without truncating or changing repeat/return points',()=>{
 assert.deepEqual(parseNativeCoordinates('45,9;1e-7,-1e-7;45,9'),[{lat:45,lon:9},{lat:1e-7,lon:-1e-7},{lat:45,lon:9}]);
 for(const value of ['45,9','45,9;91,9','45,9;Infinity,9','45,9;46,10;','45,9; 46,10',Array(17).fill('45,9').join(';'),'refId:PLACE_AAAA,refId:PLACE_BBBB','45,9;1e309,0'])assert.throws(()=>parseNativeCoordinates(value),/invalid_arguments/);
 assert.equal(parseNativeCoordinates(Array(16).fill('0,0').join(';')).length,16);
});
test('candidate arguments stay exact for lifecycle binding and reject guessed IDs or extra fields',()=>{
 const args={waypoints:'45,9;1e-7,0;45,9'};
 assert.throws(()=>prepareOperation('navigation_waypoints_request',args),/command_transport_unsupported/);
 assert.deepEqual(prepareOperation('navigation_waypoints_request',args,{coordinateWaypointsEnabled:true}).args,args);
 assert.equal(prepareOperation('navigation_sc_request',{site_id:'9223372036854775807'},{nativeSuperchargerEnabled:true}).args.site_id,'9223372036854775807');
 for(const site_id of [0,1,'0','01','1e3','9223372036854775808','IT*EVSE','Westville'])assert.throws(()=>prepareOperation('navigation_sc_request',{site_id},{nativeSuperchargerEnabled:true}),/invalid_arguments/);
 assert.throws(()=>prepareOperation('navigation_sc_request',{site_id:'123',destination:'Westville'},{nativeSuperchargerEnabled:true}),/invalid_arguments/);
});
test('only matching recent Tesla-origin selections authorize a native station identity, never a guessed public ID',async()=>{
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)};let now=1000000;
 const cache=nativeStationSelections({config,store,now:()=>now});
 const site={kind:'supercharger',tesla_site_id:'123',tesla_site_id_source:'TESLA_NEARBY_CHARGING_SITES',name:'Synthetic station',latitude:45,longitude:9};
 await assert.rejects(cache.require('owner','123'),/native_station_selection_required/);
 await cache.remember('owner',[{...site,tesla_site_id_source:'PUN'},{...site,kind:'destination_charger'}]);await assert.rejects(cache.require('owner','123'),/native_station_selection_required/);
 await cache.remember('owner',[site]);assert.equal((await cache.require('owner','123')).name,'Synthetic station');
 await assert.rejects(cache.require('other','123'),/native_station_selection_required/);await assert.rejects(cache.require('owner','124'),/native_station_selection_required/);
 assert.doesNotMatch(JSON.stringify([...rows.values()]),/Synthetic station|latitude|123/);
 now+=900001;await assert.rejects(cache.require('owner','123'),/native_station_selection_required/);
});
test('saved full route advertises a single experimental preparation only when its native gate and energy evidence agree',async()=>{
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)},plans=tripNavigation({config,store});
 const destinations=[{lat:45,lon:9},{lat:46,lon:10},{lat:45,lon:9}],itinerary={energy:{inputs:{usableCapacityKwh:68,reservePercent:15}},charging_plan:{feasible:true,policy:{reserve_percent:15},stops:[]},legs:[20,15,10.5].map(arrival_kwh=>({arrival_kwh,reserve_met:true}))};
 const ref=await plans.save('owner',{destinations,itinerary});assert.equal(ref.multi_stop_candidate_available,true);
 const read=await plans.get('owner',ref.id);assert.equal(read.multi_stop_transport_supported,true);assert.equal(read.requires_explicit_request_per_destination,false);assert.equal(read.multi_stop_vehicle_verified,false);
 assert.deepEqual(read.multi_stop_navigation_handoff.command_request,{operation:'navigation_waypoints_request',arguments:{waypoints:'45,9;46,10;45,9'}});assert.equal(read.multi_stop_navigation_handoff.api_actuation_count,1);assert.equal(read.sent_to_vehicle,false);
 const off=tripNavigation({store,config:{...config,env:{...config.env,TESLA_NATIVE_COORDINATE_ENABLED:'false'}}});const disabled=await off.get('owner',ref.id);assert.equal(disabled.multi_stop_transport_supported,false);assert.equal(disabled.multi_stop_navigation_handoff.command_request,null);assert.equal(disabled.navigation_handoff.command_request,null);assert.equal(disabled.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
});

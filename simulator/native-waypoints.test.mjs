import test from 'node:test';import assert from 'node:assert/strict';
import {prepareOperation,commandCatalog} from './lib/operation-plans.mjs';
const args={waypoints:'refId:FIXTURE_AAAA,refId:FIXTURE_BBBB,refId:FIXTURE_CCCC'};
const fixtureIds=['FIXTURE_AAAA','FIXTURE_BBBB','FIXTURE_CCCC'];
test('native candidate stays unavailable by default without changing ordinary navigation',()=>{
 assert.throws(()=>prepareOperation('navigation_waypoints_request',args),/command_transport_unsupported/);
 assert.equal(commandCatalog({executionEnabled:true}).operations.find(o=>o.operation==='navigation_waypoints_request').direct_execution_available,false);
 assert.deepEqual(prepareOperation('navigation_request',{destination:'Central Square'}).args,{destination:'Central Square'});
});
test('explicit isolated gate allows only catalog-verified ordered native references',()=>{
 assert.deepEqual(prepareOperation('navigation_waypoints_request',args,{nativeWaypointsEnabled:true,verifiedWaypointPlaceIds:fixtureIds}).args,args);
 assert.throws(()=>prepareOperation('navigation_waypoints_request',args,{nativeWaypointsEnabled:true}),/place_id_unverified/);
 for(const invalid of [{waypoints:'Laketown,Chiavenna,Hilltown'},{waypoints:'45.46,9.19'},{waypoints:'refId:FIXTURE_AAAA'},{...args,trip_plan_options:{}},{waypoints:['A','B']}])assert.throws(()=>prepareOperation('navigation_waypoints_request',invalid,{nativeWaypointsEnabled:true,verifiedWaypointPlaceIds:fixtureIds}),/invalid_arguments/);
 const unavailable=commandCatalog({executionEnabled:true,nativeWaypointsEnabled:true,verifiedWaypointPlaceIds:[]}).operations.find(o=>o.operation==='navigation_waypoints_request');
 assert.equal(unavailable.transport_supported,false);
 const o=commandCatalog({executionEnabled:true,nativeWaypointsEnabled:true,verifiedWaypointPlaceIds:fixtureIds}).operations.find(o=>o.operation==='navigation_waypoints_request');
 assert.equal(o.transport_supported,true);assert.equal(o.vehicle_test_status,'developer_reported_tested');assert.equal(o.upstream_merged,false);
 assert.equal(commandCatalog({executionEnabled:true,nativeWaypointsEnabled:true}).operations.find(o=>o.operation==='navigation_gps_request').transport_supported,false);
});

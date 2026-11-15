import test from 'node:test';
import assert from 'node:assert/strict';
import {localRedis} from '../test-support/redis-rest.mjs';
import {statusFixture} from '../test-support/mcp-status-fixture.mjs';
import {GPS_ROUTE_ORDER_SCHEMA} from '../lib/gps-route-activation.mjs';
import {TESLA_P256_ORIGIN} from '../lib/partner-p256-identity.mjs';

test('authenticated saved-plan retrieval uses real Redis, preserves whole-route order and never dispatches',async t=>{
 const db=await localRedis();t.after(()=>db.close());
 const env={APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_LOCATION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',
  TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'true',TESLA_GPS_ROUTE_ORDER_SCHEMA:GPS_ROUTE_ORDER_SCHEMA};
 const make=patch=>statusFixture(db,{}, {...env,...patch});
 const f=make(),scope='battery:read location:read';
 // All coordinates, legs and energy here are explicitly synthetic fixture data.
 const destinations=[{lat:45,lon:9},{lat:45.1,lon:9.1},{lat:45.2,lon:9.2},{lat:45,lon:9}];
 const saved={destinations,itinerary:{energy:{inputs:{usableCapacityKwh:68,reservePercent:15}},
  charging_plan:{feasible:true,policy:{reserve_percent:15},stops:[{...destinations[1],id:'fixture-dc',ccs2:true,after_leg:1}]},
  legs:[30,20,15,10.5].map(arrival_kwh=>({arrival_kwh,reserve_met:true}))}};
 const ref=await f.backend.tripPlans.save('owner',saved);
 const restarted=make();
 const result=(await restarted.rpc({id:ref.id,destinationIndex:2},{name:'get_planned_trip',scope})).result;
 assert.deepEqual(result.multi_stop_navigation_handoff.command_request.arguments.points,destinations);
 assert.equal(result.multi_stop_navigation_handoff.command_request.operation,'navigation_gps_request');
 assert.equal(result.multi_stop_navigation_handoff.automatic_dispatch,false);assert.equal(result.multi_stop_navigation_handoff.vehicle_route_verified,false);
 assert.equal(result.navigation_handoff.command_request,null);assert.equal(result.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.equal(result.single_destination_fallback_allowed,false);assert.equal(result.sent_to_vehicle,false);
 const off=make({TESLA_GPS_ROUTE_CANDIDATE_ENABLED:undefined,TESLA_GPS_ROUTE_ORDER_SCHEMA:undefined});
 const disabled=(await off.rpc({id:ref.id},{name:'get_planned_trip',scope})).result;
 assert.equal(disabled.multi_stop_navigation_handoff.command_request,null);
 assert.equal(disabled.navigation_handoff.command_request,null);
 assert.equal(disabled.single_destination_fallback_allowed,false);
 for(const insufficient of ['battery:read','location:read']){
  const denied=await restarted.rpc({id:ref.id},{name:'get_planned_trip',scope:insufficient});
  assert.equal(denied.body.result.isError,true);assert.equal(denied.result.error.code,'mcp_authorization_required');
 }
 assert.equal((await f.backend.tripPlans.get('other-owner',ref.id)).available,false);
 assert.equal(f.teslaCalls()+restarted.teslaCalls()+off.teslaCalls(),0);
 assert.ok(db.calls.some(c=>c[0]==='SET'));assert.ok(db.calls.some(c=>c[0]==='GET'));
 assert.ok(db.calls.every(c=>!String(c[1]).includes('daily-budget:')));
});

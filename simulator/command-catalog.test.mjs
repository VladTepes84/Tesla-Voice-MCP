import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCatalog, operationDefinitions } from './lib/operation-plans.mjs';
import { prepareOperation } from './lib/operation-plans.mjs';
test('known SDK gaps remain discoverable and reject preparation before any execution', () => {
  const unsupported=commandCatalog().operations.filter(x=>!x.transport_supported);
  assert.deepEqual(unsupported.map(x=>x.operation).sort(),[
    'navigation_gps_request','navigation_sc_request','navigation_waypoints_request','remote_auto_steering_wheel_heat_climate_request',
    'remote_boombox','remote_steering_wheel_heat_level_request','sun_roof_control','upcoming_calendar_entries'
  ]);
  for(const item of unsupported) assert.throws(()=>prepareOperation(item.operation,{}),/command_transport_unsupported/);
});

test('catalog describes every implemented command without asserting vehicle compatibility', () => {
  const result = commandCatalog();
  assert.equal(result.execution_enabled,false);
  assert.equal(result.operation_count,75);
  assert.deepEqual(result.operations.map(x=>x.operation),Object.keys(operationDefinitions()));
  for (const item of result.operations) {
    const definition=operationDefinitions()[item.operation];
    assert.deepEqual(item.allowed_arguments,definition.fields);
    assert.equal(item.required_tesla_scope,definition.scope);
    assert.equal(item.direct_execution_available,false);
    assert.equal(item.explicit_user_request_required,true);
    assert.equal(item.backend_confirmation_required,false);
    assert.equal(item.vehicle_support,'not_verified');
    if (!item.transport_supported) assert.ok(item.unavailable_reason);
  }
});

test('catalog snapshots cannot mutate validation definitions and enabling does not imply compatibility', () => {
  const first=commandCatalog({executionEnabled:true});
  assert.equal(first.execution_enabled,true);
  assert.equal(first.operations.filter(x=>x.direct_execution_available).length,67);
  assert.equal(first.operations.filter(x=>!x.transport_supported).length,8);
  first.operations[0].allowed_arguments.push('arbitrary_url');
  const again=commandCatalog();
  assert.ok(!again.operations[0].allowed_arguments.includes('arbitrary_url'));
  assert.ok(first.operations.every(x=>x.vehicle_support==='not_verified'));
});

test('capability matrix never promotes transport availability to mock or vehicle evidence', () => {
  for (const enabled of [false, true]) {
    for (const item of commandCatalog({ executionEnabled: enabled }).operations) {
      assert.equal(item.implementation_status, item.transport_supported ? 'transport_implemented' : 'blocked');
      assert.equal(item.mock_validation, 'not_attested_per_command');
      assert.equal(item.vehicle_test_status, 'not_tested');
    }
  }
});

test('native waypoint availability reports the same coordinate and refId gates used by preparation', () => {
  const disabled=commandCatalog({executionEnabled:true}).operations.find(x=>x.operation==='navigation_waypoints_request');
  assert.equal(disabled.transport_supported,false);
  assert.equal(disabled.direct_execution_available,false);
  assert.match(disabled.unavailable_reason,/verified Place IDs/);
  assert.match(disabled.activation_gate,/TESLA_NATIVE_WAYPOINTS_ENABLED \(refId\)/);
  const coordinates=commandCatalog({executionEnabled:true,coordinateWaypointsEnabled:true}).operations.find(x=>x.operation==='navigation_waypoints_request');
  assert.equal(coordinates.transport_supported,true);
  assert.equal(coordinates.implementation_status,'experimental_transport');
  assert.equal(coordinates.direct_execution_available,true);
  assert.equal(coordinates.activation_gate,'TESLA_NATIVE_COORDINATE_PILOT_ENABLED+TESLA_NATIVE_COORDINATE_ENABLED+TESLA_NATIVE_COORDINATE_SCHEMA');
  assert.equal(coordinates.identifiers,'lat_lon_pairs_separated_by_semicolon');
  assert.equal(coordinates.api_actuation_count,1);
  assert.equal(coordinates.vehicle_route_verified,false);
  const refs=commandCatalog({executionEnabled:true,nativeWaypointsEnabled:true,verifiedWaypointPlaceIds:['PLACE_ID_AAA','PLACE_ID_BBB']}).operations.find(x=>x.operation==='navigation_waypoints_request');
  assert.equal(refs.implementation_status,'experimental_transport');
 assert.match(refs.activation_gate,/TESLA_NATIVE_WAYPOINTS_ENABLED/);
 assert.equal(refs.identifiers,'verified_refId_values_separated_by_comma');
});

test('unsupported dedicated Supercharger command does not hide ordinary station navigation', () => {
  const catalog=commandCatalog({executionEnabled:true});
  const sc=catalog.operations.find(x=>x.operation==='navigation_sc_request');
  const navigation=catalog.operations.find(x=>x.operation==='navigation_request');
  assert.equal(sc.transport_supported,false);
  assert.equal(sc.direct_execution_available,false);
  assert.equal(sc.single_destination_alternative.operation,'navigation_request');
  assert.equal(sc.single_destination_alternative.requires_unambiguous_station,true);
  assert.equal(sc.single_destination_alternative.requires_explicit_user_request,true);
  assert.equal(sc.single_destination_alternative.automatic_fallback,false);
  assert.equal(sc.single_destination_alternative.battery_preconditioning_verified,false);
  assert.equal(navigation.direct_execution_available,true);
  assert.ok(navigation.destination_types.includes('identified_charging_station'));
  assert.equal(navigation.battery_preconditioning_verified,false);
  // Centralville public address from Tesla's official site. Validation is not a send.
  const destination='Tesla Supercharger Centralville, Example Centre, Via Sample 11, Centralville, Italia';
  const plan=prepareOperation('navigation_request',{destination});
  assert.equal(plan.operation,'navigation_request');
  assert.equal(plan.executable,false);
  assert.throws(()=>prepareOperation('navigation_sc_request',{}),/command_transport_unsupported/);
  sc.single_destination_alternative.operation='door_unlock';
  navigation.destination_types.push('arbitrary_command');
  const again=commandCatalog({executionEnabled:true});
  assert.equal(again.operations.find(x=>x.operation==='navigation_sc_request').single_destination_alternative.operation,'navigation_request');
  assert.ok(!again.operations.find(x=>x.operation==='navigation_request').destination_types.includes('arbitrary_command'));
});

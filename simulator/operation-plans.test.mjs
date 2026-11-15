import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareOperation } from './lib/operation-plans.mjs';
import { operationDefinitions } from './lib/operation-plans.mjs';
test('owner security resets and guest-data erase require exact empty arguments and confirmation', () => {
  for (const name of ['clear_pin_to_drive_admin','reset_pin_to_drive_pin','reset_valet_pin','speed_limit_clear_pin_admin','erase_user_data']) {
    const plan=prepareOperation(name,{});
    assert.equal(plan.risk,'sensitive');
    assert.equal(plan.confirmation_required,true);
    assert.equal(plan.executable,false);
    assert.equal(plan.tesla_scope,'vehicle_cmds');
    assert.throws(()=>prepareOperation(name,{pin:'must-not-be-accepted'}),/invalid_arguments/);
  }
});

test('PIN and parental-control commands accept only four-digit PINs and documented settings', () => {
  for (const operation of ['set_pin_to_drive', 'set_valet_mode']) {
    assert.equal(prepareOperation(operation, { on: true, pin: '0123' }).risk, 'sensitive');
    assert.throws(() => prepareOperation(operation, { on: true, pin: '123' }), /invalid_arguments/);
    assert.throws(() => prepareOperation(operation, { on: true, pin: '12a4' }), /invalid_arguments/);
    assert.equal(prepareOperation(operation, { on: false }).risk, 'sensitive');
    assert.throws(() => prepareOperation(operation, { on: false, pin: '0123' }), /invalid_arguments/);
  }
  for (const operation of ['speed_limit_activate', 'speed_limit_deactivate', 'speed_limit_clear_pin', 'parental_controls_activate', 'parental_controls_deactivate']) {
    assert.equal(prepareOperation(operation, { pin: '0123' }).risk, 'sensitive');
    assert.throws(() => prepareOperation(operation, { pin: '123' }), /invalid_arguments/);
  }
  assert.equal(prepareOperation('parental_controls_enable_setting', { setting: 'browser_blocked', enable: true }).risk, 'sensitive');
  assert.throws(() => prepareOperation('parental_controls_enable_setting', { setting: 'unknown', enable: true }), /invalid_arguments/);
  assert.equal(prepareOperation('parental_controls_set_speed_limit', { limit_mph: 65 }).risk, 'sensitive');
  assert.throws(() => prepareOperation('parental_controls_set_speed_limit', { limit_mph: 100 }), /invalid_arguments/);
});

test('navigation and vehicle commands produce non-executable plans with explicit permission and confirmation', () => {
  for (const [name, args] of [['navigation_request',{destination:'Milano'}],['set_charge_limit',{percent:80}],['set_temps',{driver_temp:21,passenger_temp:22}],['door_unlock',{}]]) {
    const plan=prepareOperation(name,args);
    assert.equal(plan.executable,false);
    assert.equal(plan.confirmation_required,true);
    assert.equal(plan.virtual_key_required,true);
    assert.equal(plan.operation,name);
  }
  assert.equal(prepareOperation('door_unlock',{}).risk,'sensitive');
  assert.equal(prepareOperation('charge_start',{}).tesla_scope,'vehicle_charging_cmds');
  assert.equal(prepareOperation('remote_start_drive',{}).risk,'sensitive');
  assert.equal(prepareOperation('trigger_homelink',{lat:45.46,lon:9.19}).confirmation_required,true);
  assert.equal(prepareOperation('add_precondition_schedule',{lat:45.46,lon:9.19,precondition_time:420,days_of_week:'WEEKDAYS',enabled:true}).tesla_scope,'vehicle_cmds');
});

test('plans reject unknown commands, arbitrary properties and invalid values', () => {
  for (const [name, args] of [['__proto__',{}],['unknown_command',{}],['door_lock',{url:'https://example.invalid'}],['set_charge_limit',{percent:101}],['set_charge_limit',{percent:'80'}],['navigation_request',{destination:'   '}],['navigation_request',{value:'Milano'}],['set_temps',{driver_temp:21}],['charge_start',null],['add_charge_schedule',{lat:91,lon:9,start_time:420,start_enabled:true,end_time:480,end_enabled:true,days_of_week:'MON',enabled:true}],['set_scheduled_departure',{enable:true,departure_time:1500,end_off_peak_time:480}]])
    assert.throws(()=>prepareOperation(name,args));
});

test('Tesla API commands outside the pinned transport fail before execution', () => {
  for (const name of ['navigation_gps_request','navigation_sc_request','navigation_waypoints_request','sun_roof_control','upcoming_calendar_entries','remote_boombox','remote_auto_steering_wheel_heat_climate_request','remote_steering_wheel_heat_level_request']) {
    assert.throws(() => prepareOperation(name, {}), /command_transport_unsupported/);
  }
  assert.throws(() => prepareOperation('sun_roof_control', { state: 'open' }), /command_transport_unsupported/);
});

test('GPS diagnostic validates one point per explicit Replace or Append phase only behind the existing candidate gate',()=>{
 const options={gpsRouteFixtureEnabled:true,gpsDiagnosticPhase:'replace'};
 assert.deepEqual(prepareOperation('navigation_gps_request',{points:[{lat:45.5,lon:9.1}]},options).args.points,[{lat:45.5,lon:9.1}]);
 assert.deepEqual(prepareOperation('navigation_gps_request',{points:[{lat:46,lon:10}]},{...options,gpsDiagnosticPhase:'append'}).args.points,[{lat:46,lon:10}]);
 assert.throws(()=>prepareOperation('navigation_gps_request',{points:[{lat:45.5,lon:9.1}]},{gpsRouteFixtureEnabled:true}),/invalid_arguments/);
 assert.throws(()=>prepareOperation('navigation_gps_request',{points:[{lat:45.5,lon:9.1},{lat:46,lon:10}]},options),/invalid_arguments/);
 assert.throws(()=>prepareOperation('navigation_gps_request',{points:[{lat:91,lon:9}]},options),/invalid_arguments/);
 assert.throws(()=>prepareOperation('navigation_gps_request',{points:[{lat:45.5,lon:9.1}]},{gpsDiagnosticPhase:'replace'}),/command_transport_unsupported/);
});

test('Node allowlist and Tesla Go proxy allowlist stay in sync', async () => {
  assert.equal(Object.keys(operationDefinitions()).length, 75);
  const source = await readFile(new URL('./api/tesla-command-proxy.go', import.meta.url), 'utf8');
  const commandNamesBlock = source.match(/commandNames\s*=\s*map\[string\]bool\{([\s\S]*?)\n\t\}/)?.[1];
  const commandFieldsBlock = source.match(/commandFields\s*=\s*map\[string\]map\[string\]bool\{([\s\S]*?)\n\t\}/)?.[1];
  assert.ok(commandNamesBlock);
  assert.ok(commandFieldsBlock);
  const goNames = [...commandNamesBlock.matchAll(/"([a-z_]+)"\s*:\s*true/g)].map(match => match[1]).sort();
  assert.deepEqual(goNames, Object.keys(operationDefinitions()).sort());

  const goFields = new Map();
  for (const match of commandFieldsBlock.matchAll(/"([a-z_]+)"\s*:\s*\{([^}]*)\}/g)) {
    goFields.set(match[1], [...match[2].matchAll(/"([a-z_]+)"\s*:\s*true/g)].map(field => field[1]).sort());
  }
  for (const [name, definition] of Object.entries(operationDefinitions())) {
    assert.deepEqual(goFields.get(name) ?? [], [...definition.fields].sort(), `${name} proxy fields`);
  }
  for (const gate of ['VERCEL_ENV', 'APP_ORIGIN', 'TESLA_FLEET_REGION', 'TESLA_REAL_RELEASE_APPROVED',
    'TESLA_BACKEND_ENABLED', 'TESLA_READ_ENABLED', 'TESLA_COMMANDS_ENABLED', 'TESLA_COMMAND_EXECUTION_ENABLED'])
    assert.ok(source.includes(`os.Getenv("${gate}")`), `production proxy guard: ${gate}`);
  assert.ok(source.indexOf('if os.Getenv("VERCEL_ENV")') < source.indexOf('if r.URL.Path'),
    'the production gate must run before route handling');
  assert.match(source, /func claimNonce/);
  assert.match(source, /verifySignature\(/);
});


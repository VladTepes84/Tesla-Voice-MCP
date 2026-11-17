import {parseNativeCoordinates,validTeslaSiteID} from './native-navigation-candidates.mjs';
import {isVerifiedRefIdWaypointList,parseRefIdWaypointList,verifiedFrequentPlaceIds} from './frequent-waypoint-catalog.mjs';
// Allowlisted Tesla Vehicle Command Protocol actions. Transport, owner-bound
// confirmation and execution gates live in separate modules.
const definitions = Object.freeze({
  clear_pin_to_drive_admin: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  reset_pin_to_drive_pin: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  reset_valet_pin: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  parental_controls_activate: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['pin'] },
  parental_controls_clear_pin_admin: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  parental_controls_deactivate: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['pin'] },
  parental_controls_enable_setting: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['setting', 'enable'] },
  parental_controls_set_speed_limit: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['limit_mph'] },
  set_pin_to_drive: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['on', 'pin'] },
  set_valet_mode: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['on', 'pin'] },
  speed_limit_activate: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['pin'] },
  speed_limit_deactivate: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['pin'] },
  speed_limit_clear_pin: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['pin'] },
  speed_limit_clear_pin_admin: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  erase_user_data: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  navigation_gps_request: { group: 'navigation', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['points'] },
  navigation_sc_request: { group: 'navigation', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['site_id'] },
  navigation_waypoints_request: { group: 'navigation', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['waypoints'] },
  sun_roof_control: { group: 'vehicle', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['state'] },
  upcoming_calendar_entries: { group: 'vehicle', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  navigation_request: { group: 'navigation', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['destination'] },
  charge_start: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: [] },
  charge_stop: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: [] },
  charge_standard: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: [] },
  charge_max_range: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: [] },
  set_charge_limit: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: ['percent'] },
  set_charging_amps: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: ['charging_amps'] },
  set_scheduled_charging: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: ['enable', 'time'] },
  set_scheduled_departure: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: ['enable', 'departure_time', 'end_off_peak_time', 'off_peak_charging_enabled', 'off_peak_charging_weekdays_only', 'preconditioning_enabled', 'preconditioning_weekdays_only'] },
  add_charge_schedule: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: ['lat', 'lon', 'start_time', 'start_enabled', 'end_time', 'end_enabled', 'days_of_week', 'id', 'enabled', 'one_time'] },
  remove_charge_schedule: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'sensitive', fields: ['id'] },
  add_precondition_schedule: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['lat', 'lon', 'precondition_time', 'days_of_week', 'id', 'one_time', 'enabled'] },
  remove_precondition_schedule: { group: 'climate', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['id'] },
  auto_conditioning_start: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  auto_conditioning_stop: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  set_temps: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['driver_temp', 'passenger_temp'] },
  remote_seat_heater_request: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['seat_position', 'level'] },
  remote_seat_cooler_request: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['seat_position', 'seat_cooler_level'] },
  remote_auto_seat_climate_request: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['auto_seat_position', 'auto_climate_on'] },
  remote_steering_wheel_heater_request: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['on'] },
  remote_auto_steering_wheel_heat_climate_request: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['on'] },
  remote_steering_wheel_heat_level_request: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['level'] },
  set_bioweapon_mode: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['on', 'manual_override'] },
  set_preconditioning_max: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['on', 'manual_override'] },
  set_climate_keeper_mode: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['climate_keeper_mode'] },
  set_cop_temp: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['cop_temp'] },
  set_cabin_overheat_protection: { group: 'climate', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['on', 'fan_only'] },
  set_low_power_mode: { group: 'vehicle', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['enable'] },
  keep_accessory_power_mode: { group: 'vehicle', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['enable'] },
  wake_up: { group: 'vehicle', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  door_lock: { group: 'access', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  door_unlock: { group: 'access', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  set_sentry_mode: { group: 'security', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['on'] },
  guest_mode: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['enable'] },
  remote_start_drive: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
  trigger_homelink: { group: 'access', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['lat', 'lon'] },
  set_vehicle_name: { group: 'vehicle', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['vehicle_name'] },
  window_control: { group: 'access', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['command'] },
  actuate_trunk: { group: 'access', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['which_trunk'] },
  charge_port_door_open: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: [] },
  charge_port_door_close: { group: 'charging', scope: 'vehicle_charging_cmds', risk: 'ordinary', fields: [] },
  flash_lights: { group: 'signals', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  honk_horn: { group: 'signals', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  remote_boombox: { group: 'signals', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['sound_id'] },
  speed_limit_set_limit: { group: 'security', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['limit_mph'] },
  media_toggle_playback: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  media_next_track: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  media_prev_track: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  adjust_volume: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: ['volume'] },
  media_volume_up: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  media_volume_down: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  media_next_fav: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  media_prev_fav: { group: 'media', scope: 'vehicle_cmds', risk: 'ordinary', fields: [] },
  schedule_software_update: { group: 'software', scope: 'vehicle_cmds', risk: 'sensitive', fields: ['offset_sec'] },
  cancel_software_update: { group: 'software', scope: 'vehicle_cmds', risk: 'sensitive', fields: [] },
});

// The pinned Tesla Vehicle Command SDK has no implementation for these published API names.
// Keep them visible as unavailable rather than consuming quota on known failure.
const unsupportedTransport = new Set([
  'navigation_gps_request', 'navigation_sc_request', 'navigation_waypoints_request',
  'sun_roof_control', 'upcoming_calendar_entries',
  'remote_boombox', 'remote_auto_steering_wheel_heat_climate_request',
  'remote_steering_wheel_heat_level_request'
]);
const unsupportedTransportReasons = Object.freeze({
  navigation_gps_request: 'Experimental GPS multi-stop navigation is disabled. It requires controlled activation and verification of stop order on the vehicle. Do not replace it with repeated single-destination sends.',
  navigation_sc_request: 'The dedicated Supercharger command is not implemented by the current proxy. This does not prevent single-destination navigation to an identified site: use navigation_request with a verified name and address or verified coordinates, only after an explicit request. Do not invent a Tesla site ID or promise preconditioning or Supercharger recognition.',
  navigation_waypoints_request: 'Native refId waypoint batching is experimental, uses one signed command, and requires verified Place IDs in the local catalog plus TESLA_NATIVE_WAYPOINTS_ENABLED. It does not fall back to coordinates. The route has not been verified on a vehicle.',
  sun_roof_control: 'The VCP proxy does not translate stop/close/vent states into signed commands; this operation is currently unsupported.',
  upcoming_calendar_entries: 'The endpoint is documented, but the current VCP proxy does not implement this operation or its schema.',
  remote_boombox: 'The current official VCP proxy reports this command as unsupported.',
  remote_auto_steering_wheel_heat_climate_request: 'The current official VCP proxy does not implement this command.',
  remote_steering_wheel_heat_level_request: 'The current official VCP proxy does not implement this command.'
});
// A validated plan is data for dispatch; it is never itself authorization.
// Exact allowed fields prevent arbitrary parameter forwarding.
export function prepareOperation(name, args, {nativeWaypointsEnabled=false,gpsRouteFixtureEnabled=false,gpsDiagnosticPhase=null,coordinateWaypointsEnabled=false,nativeSuperchargerEnabled=false,statusOnly=false,verifiedWaypointPlaceIds,googlePlacesVerifiedIds=[]}={}) {
  if (typeof name !== 'string' || !Object.hasOwn(definitions, name)) throw Error('unsupported_operation');
  if (unsupportedTransport.has(name)&&!(name==='navigation_waypoints_request'&&(nativeWaypointsEnabled===true||coordinateWaypointsEnabled===true))&&!(name==='navigation_gps_request'&&gpsRouteFixtureEnabled===true)&&!(name==='navigation_sc_request'&&nativeSuperchargerEnabled===true)) throw Error('command_transport_unsupported');
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.getPrototypeOf(args) !== Object.prototype) throw Error('invalid_arguments');
  const definition = name==='navigation_gps_request'&&gpsRouteFixtureEnabled===true ? {...definitions[name],fields:['points']} : definitions[name];
  if (Object.keys(args).some(key => !definition.fields.includes(key))) throw Error('invalid_arguments');
  const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const boolean = v => typeof v === 'boolean';
  if(name==='navigation_gps_request'&&gpsRouteFixtureEnabled===true){
    const diagnostic=['replace','append'].includes(gpsDiagnosticPhase);
    const validLength=Array.isArray(args.points)&&(diagnostic?args.points.length===1:args.points.length>=2&&args.points.length<=16);
    if(!validLength||!args.points.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&Object.getPrototypeOf(p)===Object.prototype&&Object.keys(p).length===2&&Object.hasOwn(p,'lat')&&Object.hasOwn(p,'lon')&&finite(p.lat,-90,90)&&finite(p.lon,-180,180)))throw Error('invalid_arguments');
    if(gpsDiagnosticPhase!==null&&!diagnostic)throw Error('invalid_arguments');
  }
  if(name==='navigation_waypoints_request'){
    if(typeof args.waypoints!=='string')throw Error('invalid_arguments');
    if(args.waypoints.startsWith('refId:')){
      if(nativeWaypointsEnabled!==true&&!statusOnly)throw Error('command_transport_unsupported');
      if(!parseRefIdWaypointList(args.waypoints))throw Error('invalid_arguments');
      const trustedIds=new Set([...(verifiedWaypointPlaceIds??verifiedFrequentPlaceIds()),...(Array.isArray(googlePlacesVerifiedIds)?googlePlacesVerifiedIds:[])]);
      if(!statusOnly&&!isVerifiedRefIdWaypointList(args.waypoints,{verifiedWaypointPlaceIds:[...trustedIds]}))throw Error('place_id_unverified');
    }else{
      if(coordinateWaypointsEnabled!==true&&!statusOnly)throw Error('invalid_arguments');
      parseNativeCoordinates(args.waypoints);
    }
  }
  if(name==='navigation_sc_request'&&!validTeslaSiteID(args.site_id))throw Error('invalid_arguments');
  if (name === 'navigation_request' && (typeof args.destination !== 'string' || !args.destination.trim() || args.destination.length > 256)) throw Error('invalid_arguments');
  if (name === 'set_charge_limit' && !integer(args.percent, 50, 100)) throw Error('invalid_arguments');
  const validPin = value => typeof value === 'string' && /^\d{4}$/.test(value);
  if (['set_pin_to_drive', 'set_valet_mode'].includes(name)) {
    if (!boolean(args.on)) throw Error('invalid_arguments');
    if (args.on ? !validPin(args.pin) : args.pin !== undefined) throw Error('invalid_arguments');
  }
  if (['speed_limit_activate', 'speed_limit_deactivate', 'speed_limit_clear_pin', 'parental_controls_activate', 'parental_controls_deactivate'].includes(name) && !validPin(args.pin)) throw Error('invalid_arguments');
  if (name === 'parental_controls_enable_setting' && (!['speed_limit', 'acceleration', 'safety_features', 'curfew', 'browser_blocked', 'theater_blocked', 'arcade_blocked'].includes(args.setting) || !boolean(args.enable))) throw Error('invalid_arguments');
  if (name === 'parental_controls_set_speed_limit' && !integer(args.limit_mph, 50, 90)) throw Error('invalid_arguments');
  if (name === 'set_charging_amps' && !integer(args.charging_amps, 1, 48)) throw Error('invalid_arguments');
  if (name === 'set_scheduled_charging' && (!boolean(args.enable) || !integer(args.time, 0, 1439))) throw Error('invalid_arguments');
  if (name === 'set_scheduled_departure') {
    if (!boolean(args.enable)) throw Error('invalid_arguments');
    const optionalBooleans = ['off_peak_charging_enabled', 'off_peak_charging_weekdays_only', 'preconditioning_enabled', 'preconditioning_weekdays_only'];
    if (optionalBooleans.some(key => args[key] !== undefined && !boolean(args[key]))) throw Error('invalid_arguments');
    if (args.enable && (!integer(args.departure_time, 0, 1439) || !integer(args.end_off_peak_time, 0, 1439))) throw Error('invalid_arguments');
    if (!args.enable && Object.keys(args).some(key => key !== 'enable')) throw Error('invalid_arguments');
  }
  const validDays = value => typeof value === 'string' && value.length <= 80 && value.split(',').length > 0 && value.split(',').every(day => ['SUN','SUNDAY','MON','MONDAY','TUES','TUESDAY','WED','WEDNESDAY','THURS','THURSDAY','FRI','FRIDAY','SAT','SATURDAY','ALL','WEEKDAYS'].includes(day.trim().toUpperCase()));
  if (name === 'add_charge_schedule' && (!finite(args.lat, -90, 90) || !finite(args.lon, -180, 180) || !integer(args.start_time, 0, 1439) || !boolean(args.start_enabled) || !integer(args.end_time, 0, 1439) || !boolean(args.end_enabled) || !validDays(args.days_of_week) || !boolean(args.enabled) || (args.id !== undefined && !integer(args.id, 0, Number.MAX_SAFE_INTEGER)) || (args.one_time !== undefined && !boolean(args.one_time)))) throw Error('invalid_arguments');
  if (name === 'remove_charge_schedule' && !integer(args.id, 1, Number.MAX_SAFE_INTEGER)) throw Error('invalid_arguments');
  if (name === 'add_precondition_schedule' && (!finite(args.lat, -90, 90) || !finite(args.lon, -180, 180) || !integer(args.precondition_time, 0, 1439) || !validDays(args.days_of_week) || !boolean(args.enabled) || (args.id !== undefined && !integer(args.id, 0, Number.MAX_SAFE_INTEGER)) || (args.one_time !== undefined && !boolean(args.one_time)))) throw Error('invalid_arguments');
  if (name === 'remove_precondition_schedule' && !integer(args.id, 1, Number.MAX_SAFE_INTEGER)) throw Error('invalid_arguments');
  if (name === 'set_temps' && (!finite(args.driver_temp, 15, 30) || !finite(args.passenger_temp, 15, 30))) throw Error('invalid_arguments');
  if (name === 'remote_seat_heater_request' && (!integer(args.seat_position, 0, 8) || !integer(args.level, 0, 3))) throw Error('invalid_arguments');
  if (name === 'remote_seat_cooler_request' && (!integer(args.seat_position, 0, 1) || !integer(args.seat_cooler_level, 1, 3))) throw Error('invalid_arguments');
  if (name === 'remote_auto_seat_climate_request' && (!integer(args.auto_seat_position, 0, 1) || !boolean(args.auto_climate_on))) throw Error('invalid_arguments');
  if (['remote_steering_wheel_heater_request','remote_auto_steering_wheel_heat_climate_request'].includes(name) && !boolean(args.on)) throw Error('invalid_arguments');
  if (name === 'remote_steering_wheel_heat_level_request' && !integer(args.level, 0, 3)) throw Error('invalid_arguments');
  if (name === 'set_bioweapon_mode' && (!boolean(args.on) || !boolean(args.manual_override))) throw Error('invalid_arguments');
  if (name === 'set_preconditioning_max' && (!boolean(args.on) || (args.manual_override !== undefined && !boolean(args.manual_override)))) throw Error('invalid_arguments');
  if (name === 'set_climate_keeper_mode' && !integer(args.climate_keeper_mode, 0, 3)) throw Error('invalid_arguments');
  if (name === 'set_cop_temp' && !integer(args.cop_temp, 0, 2)) throw Error('invalid_arguments');
  if (name === 'set_cabin_overheat_protection' && (!boolean(args.on) || !boolean(args.fan_only))) throw Error('invalid_arguments');
  if (['set_low_power_mode','keep_accessory_power_mode','guest_mode'].includes(name) && !boolean(args.enable)) throw Error('invalid_arguments');
  if (name === 'trigger_homelink' && (!finite(args.lat, -90, 90) || !finite(args.lon, -180, 180))) throw Error('invalid_arguments');
  if (name === 'set_vehicle_name' && (typeof args.vehicle_name !== 'string' || !args.vehicle_name.trim() || args.vehicle_name.length > 64)) throw Error('invalid_arguments');
  if (name === 'set_sentry_mode' && !boolean(args.on)) throw Error('invalid_arguments');
  if (name === 'sun_roof_control' && !['stop', 'close', 'vent'].includes(args.state)) throw Error('invalid_arguments');
  if (name === 'remote_boombox' && !integer(args.sound_id, 2000, 2000)) throw Error('invalid_arguments');
  if (name === 'speed_limit_set_limit' && !integer(args.limit_mph, 50, 90)) throw Error('invalid_arguments');
  if (name === 'window_control' && !['close', 'vent'].includes(args.command)) throw Error('invalid_arguments');
  if (name === 'actuate_trunk' && !['front', 'rear'].includes(args.which_trunk)) throw Error('invalid_arguments');
  if (name === 'adjust_volume' && !finite(args.volume, 0, 100)) throw Error('invalid_arguments');
  if (name === 'schedule_software_update' && !integer(args.offset_sec, 0, 2592000)) throw Error('invalid_arguments');
  return { operation: name, group: definition.group, tesla_scope: definition.scope, risk: definition.risk,
    args: { ...args }, executable: false, confirmation_required: true, virtual_key_required: true };
}

export function operationDefinitions() { return definitions; }

/** Describes operations and developer-reported testing, not general vehicle support. */
export function commandCatalog({ executionEnabled = false, nativeWaypointsEnabled=false,gpsRouteCandidateEnabled=false,coordinateWaypointsEnabled=false,nativeSuperchargerEnabled=false,verifiedWaypointPlaceIds } = {}) {
  const trustedPlaceIds=verifiedWaypointPlaceIds??verifiedFrequentPlaceIds();
  const nativeRefIdPayloadReady=nativeWaypointsEnabled===true&&new Set(trustedPlaceIds).size>=2;
  const waypointTransportEnabled=nativeRefIdPayloadReady||coordinateWaypointsEnabled===true;
  const waypointActivationGate=coordinateWaypointsEnabled===true
    ? 'TESLA_NATIVE_COORDINATE_PILOT_ENABLED+TESLA_NATIVE_COORDINATE_ENABLED+TESLA_NATIVE_COORDINATE_SCHEMA'
    : nativeWaypointsEnabled===true ? 'TESLA_NATIVE_WAYPOINTS_ENABLED + almeno 2 Place ID verificati nel catalogo locale'
      : 'TESLA_NATIVE_COORDINATE_PILOT_ENABLED+TESLA_NATIVE_COORDINATE_ENABLED+TESLA_NATIVE_COORDINATE_SCHEMA (coordinates) OR TESLA_NATIVE_WAYPOINTS_ENABLED (refId)';
  const blocked=op=>unsupportedTransport.has(op)&&!(op==='navigation_waypoints_request'&&waypointTransportEnabled)&&!(op==='navigation_gps_request'&&gpsRouteCandidateEnabled===true)&&!(op==='navigation_sc_request'&&nativeSuperchargerEnabled===true);
  const operations = Object.entries(definitions).map(([operation, definition]) => ({
    operation, group: definition.group, required_tesla_scope: definition.scope,
    risk: definition.risk, allowed_arguments: operation==='navigation_gps_request'&&gpsRouteCandidateEnabled ? ['points'] : [...definition.fields],
    transport_supported: !blocked(operation),
    implementation_status: blocked(operation) ? 'blocked' : (operation==='navigation_gps_request'||operation==='navigation_sc_request'||operation==='navigation_waypoints_request'&&waypointTransportEnabled) ? 'experimental_transport' : 'transport_implemented',
    mock_validation: 'not_attested_per_command',
    vehicle_test_status: 'developer_reported_tested',
    ...(operation==='navigation_waypoints_request'&&waypointTransportEnabled?{vehicle_test_evidence_scope:'No independent evidence of general vehicle compatibility.'}:{}),
    ...(blocked(operation) ? { unavailable_reason: unsupportedTransportReasons[operation] } : {}),
    direct_execution_available: executionEnabled === true && !blocked(operation),
    explicit_user_request_required: true,
    backend_confirmation_required: false,
    transport: 'tesla-vehicle-command-v0.4.2-0.20260625231214-ed0cacc3f594',
    vehicle_support: 'not_verified',
    ...(operation==='navigation_sc_request'?{experimental:nativeSuperchargerEnabled,station_identity_source:'authenticated_tesla_nearby_selection_only',battery_preconditioning_verified:false,single_destination_alternative:{operation:'navigation_request',via_existing_tool:'execute_requested_vehicle_command',destination:'verified_station_name_and_address_or_coordinates',requires_unambiguous_station:true,requires_explicit_user_request:true,automatic_fallback:false,tesla_supercharger_identity_verified:false,battery_preconditioning_verified:false}}:{}),
    ...(operation==='navigation_request'?{destination_types:['place_name_and_address','coordinates','identified_charging_station'],battery_preconditioning_verified:false}:{}),
    ...(operation==='navigation_gps_request'?{transport:'official_sdk_hmac_with_experimental_gps_codec',activation_gate:'TESLA_GPS_ROUTE_CANDIDATE_ENABLED',ordered_points_only:true,atomic:false,vehicle_test_status:'developer_reported_tested'}:{}),
    ...(operation==='navigation_waypoints_request'?{transport:'official_sdk_hmac_with_local_pr443_codec',extension:'isolated_native_waypoints_candidate',activation_gate:waypointActivationGate,identifiers:coordinateWaypointsEnabled?'lat_lon_pairs_separated_by_semicolon':nativeWaypointsEnabled?'verified_refId_values_separated_by_comma':'lat_lon_pairs_separated_by_semicolon_or_verified_refId_values',api_actuation_count:waypointTransportEnabled?1:null,vehicle_route_verified:false,upstream_merged:false}:{} )
  }));
  return { source: 'APP_COMMAND_CATALOG', execution_enabled: executionEnabled === true,
    operation_count: operations.length, operations,
    note: 'Execution requires an explicit user request. Direct execution does not require a second backend confirmation; the MCP client may still show an approval prompt. Operations with direct_execution_available=false cannot be executed. Catalog inclusion does not confirm compatibility with vehicle hardware, firmware, or state. This lookup does not contact Tesla.' };
}


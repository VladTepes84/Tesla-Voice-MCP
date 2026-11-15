import { authenticate } from './security.mjs';

export function requiredToolScope(name) {
  if (['connect_tesla','prepare_vehicle_command_setup'].includes(name)) return 'tesla:connect';
  if (['resolve_frequent_waypoints','resolve_waypoint_places','get_saved_trip_places','set_saved_trip_place','get_vehicle_location','get_nearby_charging_sites','search_trip_destination','plan_road_trip','find_charging_sites','reverse_trip_location','get_live_vehicle_address','plan_charging_road_trip','plan_smart_trip','get_planned_trip'].includes(name)) return 'location:read';
  if (['prepare_vehicle_command','execute_vehicle_command','execute_requested_vehicle_command','get_vehicle_command_status','start_gps_navigation_diagnostic','append_gps_navigation_diagnostic'].includes(name)) return 'vehicle:control';
  return 'battery:read';
}

export function mcpAuthorizationRequired(origin, name) {
  const scope=['plan_smart_trip','get_planned_trip'].includes(name) ? 'battery:read location:read' : requiredToolScope(name);
  return {
    content: [{type:'text',text:JSON.stringify({error:{code:'mcp_authorization_required',
      message:'The MCP client connection must authorize the permission required by this tool.',required_scope:scope}})}],
    isError:true,
    _meta:{'mcp/www_authenticate':[
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="Additional authorization required", scope="${scope}"`
    ]}
  };
}

export function mcpCallerPermissions(request, config) {
  return Object.fromEntries(['tesla:connect','battery:read','location:read','vehicle:control'].map(scope=>{
    try { authenticate(request,config,scope); return [scope,true]; }
    catch { return [scope,false]; }
  }));
}

# Changelog & capability map

**Tesla Voice MCP — public, self-hosted edition.** A dated history of changes, followed by a readable map of the currently documented MCP tools and Tesla command operations.

> **Important:** an MCP tool is **not necessarily a Tesla Fleet API endpoint**. Some tools use cached data, local calculations, maps or stored preferences; others call Tesla Fleet API, and guarded command tools dispatch selected Tesla vehicle operations. A listed capability is not proof of live vehicle compatibility. Each operator supplies their own deployment and authorization.

**Quick links:** [Install](docs/INSTALLATION.md) · [Complete tool reference](docs/TOOLS_REFERENCE.md) · [Full command catalog](docs/FEATURES.md#5-remote-tesla-commands) · [Security](docs/SECURITY_MODEL.md) · [Evidence](docs/EVIDENCE.md)

## Release history

### 2026-11-19 — Tesla Service History (public repository)

**Added two read-only MCP tools** in [PR #4](https://github.com/VladTepes84/Tesla-Voice-MCP/pull/4), merged into `main`:

| New MCP tool | Tesla Fleet API resource | What it does | Safety / limits |
| --- | --- | --- | --- |
| `get_service_history` | `GET /api/1/vehicles/{vin}/service_history` | Lists completed service visits for the currently authorized owner; supports pages and up to 50 entries per page. | Requires Tesla `vehicle_device_data`, MCP `battery:read`; no automatic wake or commands. |
| `get_service_visit_details` | `GET /api/1/vehicles/{vin}/service_history/{service_visit_id}` | Reads a selected visit's work items, payment/warranty classification and invoice amounts when returned. | Validates the visit ID, filters returned fields; no automatic wake or commands. |

**Validation:** offline CI [541/541 Node tests, Go tests/build/vet](https://github.com/VladTepes84/Tesla-Voice-MCP/actions/runs/44490897133) and [Gitleaks](https://github.com/VladTepes84/Tesla-Voice-MCP/actions/runs/44490896646) passed on the integration candidate. No claim of a live service-history read from a particular vehicle.

**Tesla source:** [Fleet API announcements](https://developer.tesla.com/docs/fleet-api/announcements) · [Vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints). Tesla announced the endpoints on **2026-11-11**; the date above records their addition to this public project, not their original Tesla release.

### Before 2026-11-19 — Existing capabilities

The existing public baseline already includes cached/live vehicle reads, account linking, route and charging planning, map search, stored preferences, command preparation/execution gates, and a source catalog of 75 vehicle operations. **No historical release dates are assigned to these earlier features without dated evidence.** See [feature inventory](docs/FEATURES.md) and [evidence](docs/EVIDENCE.md).

## Current MCP tools — 40 interface entry points

This is a navigation-oriented summary of the **current documented catalog**, not 40 Tesla endpoints. Actual visibility depends on deployment flags, scopes, and client permissions. For exact arguments and current schemas, use the authenticated MCP `tools/list` response or [the reference](docs/TOOLS_REFERENCE.md).

### Connection & authorization (4)

| MCP tool | Calls / action | Purpose |
| --- | --- | --- |
| `connect_tesla` | Tesla OAuth linking flow | Initiates owner-authorized account connection. |
| `get_connection_status` | Local connection state | Checks authorization, scopes and budget without waking a vehicle. |
| `prepare_vehicle_command_setup` | Local setup / Tesla prerequisites | Explains pairing and signed-command setup. |
| `get_vehicle_command_catalog` | Local allowlisted catalog | Lists vehicle operations, parameters and execution availability. |

### Vehicle, charging & service reads (10)

| MCP tool | Calls / action | Purpose |
| --- | --- | --- |
| `get_battery` | Cached Tesla snapshot | Battery, range and charging state with timestamp. |
| `get_vehicle_status` | Cached Tesla snapshot | Climate, locks, software and other available state. |
| `get_live_vehicle_data` | Tesla Fleet API on demand | Requests fresh vehicle data; may contact or wake the vehicle. |
| `get_vehicle_reading_history` | Local sample store | Reads application-collected historical samples. |
| `get_vehicle_connectivity` | Tesla connectivity read | Reads reported online/asleep/offline status. |
| `get_vehicle_mobile_access` | Tesla mobile-access read | Reads mobile-access status without changing it. |
| `get_charging_history` | Tesla charging history | Retrieves recent charging sessions when available. |
| `get_service_history` | Tesla Service History GET | Lists completed service visits with pagination. **Added 2026-11-19.** |
| `get_service_visit_details` | Tesla Service History detail GET | Retrieves one visit's work and available costs. **Added 2026-11-19.** |
| `get_vehicle_schedules` | Tesla schedule read | Reads native charging/preconditioning schedules without editing. |

### Location & destination preparation (10)

| MCP tool | Calls / action | Purpose |
| --- | --- | --- |
| `get_vehicle_location` | Tesla location read | Retrieves current position and available navigation information. |
| `get_live_vehicle_address` | Tesla GPS + consented geocoding | Converts vehicle location into an approximate address. |
| `get_nearby_charging_sites` | Tesla/provider lookup | Lists nearby charging candidates; not guaranteed live pricing. |
| `reverse_trip_location` | External reverse geocoder | Resolves caller-provided coordinates, without reading the vehicle. |
| `search_trip_destination` | OSM/Photon geocoding | Searches and disambiguates a named destination. |
| `get_saved_trip_places` | Local private store | Reads operator-saved destination aliases. |
| `set_saved_trip_place` | Local private store | Adds, updates or deletes a confirmed alias. |
| `resolve_frequent_waypoints` | Local waypoint catalog | Prepares ordered verified waypoint identifiers, without dispatch. |
| `resolve_waypoint_places` | Optional Google Places | Resolves named destinations to Place IDs with consent and setup. |
| `get_planned_trip` | Local trip store | Retrieves a previously prepared itinerary; no vehicle dispatch. |

### Energy, charging, maps & preferences (10)

| MCP tool | Calls / action | Purpose |
| --- | --- | --- |
| `estimate_trip_energy` | Local calculation | Estimates journey energy, battery use and reserve. |
| `compare_charging_costs` | Local calculation | Compares two operator-supplied tariffs. |
| `plan_trip` | Local calculation | Combines energy and cost estimates. |
| `plan_road_trip` | External OSRM routing | Estimates road distance and routing. |
| `find_charging_sites` | External charging/map sources | Finds nearby AC/DC/CCS2 charging candidates. |
| `plan_charging_road_trip` | Routing + charging data + estimates | Suggests charging stops under battery/reserve constraints. |
| `plan_smart_trip` | Geocoding + local planning | Prepares ordered multi-stop itineraries; not guaranteed native delivery. |
| `get_charging_preferences` | Local private store | Reads configured battery, reserve and consent preferences. |
| `set_charging_preferences` | Local private store | Saves explicitly confirmed preferences. |
| `get_free_to_x_card_tariffs` | Public tariff source | Attempts to retrieve published direct-card/POS tariffs; not a personal contract. |

### Vehicle command workflow (6)

| MCP tool | Calls / action | Purpose |
| --- | --- | --- |
| `prepare_vehicle_command` | Local validation / staging | Prepares a permitted operation without executing it. |
| `execute_vehicle_command` | Guarded Tesla command | Dispatches a previously staged and confirmed operation. |
| `execute_requested_vehicle_command` | Guarded Tesla command | Dispatches one explicitly requested operation, subject to gates. |
| `get_vehicle_command_status` | Local command journal | Checks receipts; API acceptance is not proof of vehicle actuation. |
| `start_gps_navigation_diagnostic` | Experimental guarded Tesla command | Starts a GPS navigation diagnostic (Replace). |
| `append_gps_navigation_diagnostic` | Experimental guarded Tesla command | Appends a GPS diagnostic after separately confirmed observation. |

## Tesla vehicle operation catalog — 75 names

These are **command names dispatched through the MCP command workflow**, not 75 additional MCP tools. Exact argument schemas and authorization requirements are defined in `simulator/lib/operation-plans.mjs` and returned by `get_vehicle_command_catalog`.

| Area | Vehicle operation names | What they control |
| --- | --- | --- |
| Charging | `charge_start`, `charge_stop`, `charge_standard`, `charge_max_range`, `set_charge_limit`, `set_charging_amps`, `set_scheduled_charging`, `set_scheduled_departure`, `add_charge_schedule`, `remove_charge_schedule`, `charge_port_door_open`, `charge_port_door_close` | Charging sessions, current, target, port and schedules. |
| Climate | `add_precondition_schedule`, `remove_precondition_schedule`, `auto_conditioning_start`, `auto_conditioning_stop`, `set_temps`, `remote_seat_heater_request`, `remote_seat_cooler_request`, `remote_auto_seat_climate_request`, `remote_steering_wheel_heater_request`, `remote_auto_steering_wheel_heat_climate_request`, `remote_steering_wheel_heat_level_request`, `set_bioweapon_mode`, `set_preconditioning_max`, `set_climate_keeper_mode`, `set_cop_temp`, `set_cabin_overheat_protection` | Cabin climate, seat/wheel heating or cooling and preconditioning. |
| Access & signals | `door_lock`, `door_unlock`, `trigger_homelink`, `window_control`, `actuate_trunk`, `flash_lights`, `honk_horn`, `remote_boombox` | Locks, windows, trunk, HomeLink, horn and lights. |
| Security & restrictions | `clear_pin_to_drive_admin`, `reset_pin_to_drive_pin`, `reset_valet_pin`, `parental_controls_activate`, `parental_controls_clear_pin_admin`, `parental_controls_deactivate`, `parental_controls_enable_setting`, `parental_controls_set_speed_limit`, `set_pin_to_drive`, `set_valet_mode`, `speed_limit_activate`, `speed_limit_deactivate`, `speed_limit_clear_pin`, `speed_limit_clear_pin_admin`, `erase_user_data`, `set_sentry_mode`, `guest_mode`, `remote_start_drive`, `speed_limit_set_limit` | Security modes, PINs, limits and sensitive vehicle controls. |
| Navigation | `navigation_request`, `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request` | Destination and experimental GPS/Supercharger/waypoint paths. |
| Vehicle & software | `sun_roof_control`, `upcoming_calendar_entries`, `set_low_power_mode`, `keep_accessory_power_mode`, `wake_up`, `set_vehicle_name`, `schedule_software_update`, `cancel_software_update` | Vehicle configuration, power, wake and software scheduling. |
| Media | `media_toggle_playback`, `media_next_track`, `media_prev_track`, `adjust_volume`, `media_volume_up`, `media_volume_down`, `media_next_fav`, `media_prev_fav` | Media playback and volume. |

**Availability warning:** eight operation transports are unavailable by default in the pinned SDK/proxy: `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request`, `sun_roof_control`, `upcoming_calendar_entries`, `remote_boombox`, `remote_auto_steering_wheel_heat_climate_request`, `remote_steering_wheel_heat_level_request`. Some navigation paths are experimental and separately gated. The catalog is **not** a guarantee of compatibility or successful execution on a particular Tesla.

## How this file is maintained

- Add a dated release entry **only when a change lands in this public repository**. Distinguish Tesla's API announcement date from the integration date.
- Describe added/changed/removed tools, underlying Tesla endpoints or non-Tesla providers, safety impact, and verification evidence.
- Keep the **current capability map** in sync with [TOOLS_REFERENCE.md](docs/TOOLS_REFERENCE.md), [FEATURES.md](docs/FEATURES.md) and the source. Do not treat the historical entries as the current API schema.
- Never publish tokens, VINs, account data, deployment-specific configuration or vehicle locations.

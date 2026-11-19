# Changelog — Tesla Voice MCP

> Last source review: **19 November 2026** · Public open-source repository only · No private credentials, deployments or vehicle identifiers.

**Purpose:** a dated implementation history plus a searchable inventory of **all 40 MCP tools**, **75 vehicle command operations**, and the principal Tesla Fleet API endpoints referenced by the source. A named tool or operation is not a guarantee of live compatibility.

## Release history (public Git commits)

| Date | What changed | Source |
| --- | --- | --- |
| **2026-11-19** | **Added Tesla Service History:** `get_service_history` (paginated visits) and `get_service_visit_details` (service work and available costs). Updated MCP catalog to **40 tools**, included offline tests and read-only safeguards. | [PR #4](https://github.com/VladTepes84/Tesla-Voice-MCP/pull/4) · [`9555238c`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/9555238c1638) |
| **2026-11-18** | Added optional GitHub Sponsors support in the repository; no Tesla functionality changed. | [`dcf789b4`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/dcf789b48ec3) · [`92d35cca`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/92d35ccacd56) |
| **2026-11-17** | Added support for **up to 16 ordered navigation-only destinations**, protected behind preparation/dispatch boundaries. Extended onboarding, security scanning and documentation for multiple AI clients, Google Places and maps. Documented developer-reported real vehicle tests separately from offline CI. | [`8011ae7b`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/8011ae7b57d6) · [`265948ff`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/265948ff84b5) · [`a90af3a7`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/a90af3a7ab55) |
| **2026-11-16** | Prepared sanitized public release and feature documentation. | [`ee069d13`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/ee069d1334b9) |
| **2026-11-15** | Initial sanitized repository baseline, already containing the **75-operation command catalog**. Individual original implementation dates are not established. | [`2ea43c11`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/2ea43c11dfaa) |

Dates above are **public Git commit dates**, not Tesla announcement dates or dates of physical tests. A user must update and configure their own self-hosted instance to obtain newly merged functionality.

## What is a tool versus a Tesla operation?

- **40 MCP tools:** assistant-visible actions, locally calculated results, provider reads, storage, command preparation/execution and diagnostics. Tool availability depends on authorization and feature flags.
- **75 Tesla operations:** named Vehicle Command SDK/proxy operations dispatched through guarded MCP command tools. They are **not** 75 different REST endpoints.
- **8 default-blocked transports:** the pinned proxy lacks default support; certain navigation transports have separately gated experimental paths.
- Developer-reported tests on a real Tesla are distinct from independent verification, offline automated tests, and actual transport availability for other vehicles.

## Tesla Fleet API surfaces used by this code

These routes are identifiable in `simulator/lib/tesla.mjs` and represent the principal vehicle-read API surface, **not Tesla's entire API**. The Vehicle Command SDK/proxy has different command-specific behavior.

| Tesla route / interface | Used for |
| --- | --- |
| Tesla OAuth `/oauth2/v3/authorize`, `/oauth2/v3/token` | Account linking and token renewal (separate from client MCP OAuth) |
| `GET /api/1/vehicles/{vin}` | Vehicle connectivity state |
| `GET /api/1/vehicles/{vin}/mobile_enabled` | Mobile access state |
| `GET /api/1/vehicles/{vin}/vehicle_data_cached` | Cached battery and vehicle status; does not wake the vehicle |
| `GET /api/1/vehicles/{vin}/vehicle_data` | Explicit live reading, vehicle schedules and location |
| `GET /api/1/vehicles/{vin}/nearby_charging_sites?detail=true` | Nearby Tesla charging-site information |
| `GET /api/1/dx/charging/history` | Recent charging history; not a complete invoice ledger |
| `GET /api/1/vehicles/{vin}/service_history` | **2026-11-19:** list current-owner service visits (paginated) |
| `GET /api/1/vehicles/{vin}/service_history/{service_visit_id}` | **2026-11-19:** service-visit details and available costs |

Official references: [Tesla Fleet API endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints) · [Tesla announcements](https://developer.tesla.com/docs/fleet-api/announcements). External map, charging-data, routing and Google Places queries are separate, optional providers.

## Full MCP tool inventory — 40 tools

All scope/effect descriptions are source-derived from [TOOLS_REFERENCE.md](docs/TOOLS_REFERENCE.md). The live `tools/list` response on an operator's installation is authoritative for enabled tool schemas.

### Authentication, connection and permissions (4)

| Tool | Scope | Effect | What it does |
| --- | --- | --- | --- |
| `connect_tesla` | `tesla:connect` | Tesla OAuth linking | Explicitly initiated linking; not a token export |
| `get_connection_status` | `battery:read` | Local | Link state, scopes, gates and request budget; no vehicle contact |
| `prepare_vehicle_command_setup` | `tesla:connect` | Setup assistance | Virtual-key and partner prerequisites; not an implicit registration |
| `get_vehicle_command_catalog` | `battery:read` | Local | Operation names, parameter schemas, scopes and current dispatch availability |

### Vehicle readings, charging, service and connectivity (10)

| Tool | Scope | Effect | What it does |
| --- | --- | --- | --- |
| `get_battery` | `battery:read` | Cached | Includes timestamp; may be stale |
| `get_vehicle_status` | `battery:read` | Cached | Climate, locks, Sentry, odometer and software fields when available |
| `get_live_vehicle_data` | `battery:read` | Live | Single on-demand read; may contact/wake; no silent fallback or retry |
| `get_vehicle_reading_history` | `battery:read` | Local | App-collected samples for up to 31 days, not full Tesla telemetry |
| `get_vehicle_connectivity` | `battery:read` | Live | Online/asleep/offline as reported; no implicit wake |
| `get_vehicle_mobile_access` | `battery:read` | Live | Reads mobile-access state; does not modify it |
| `get_charging_history` | `battery:read` | Live/history | Recent returned sessions; not a universal invoice |
| `get_service_history` | `battery:read` | Tesla Service/history | Completed visits for the current owner; `per_page` 1–50, follow `pagination.next` until `null`; deduplicate repeated visit IDs across pages; no vehicle wake |
| `get_service_visit_details` | `battery:read` | Tesla Service/history | On-demand work items, payment type and final-invoice totals when available; non-invoiced/warranty visits can have no costs; no vehicle wake |
| `get_vehicle_schedules` | `battery:read` | Live | Reads charge/preconditioning schedules; does not edit them |

### Location, place resolution and private aliases (10)

| Tool | Scope | Effect | What it does |
| --- | --- | --- | --- |
| `get_vehicle_location` | `location:read` | Live/private | Sensitive location, available destination/ETA; may contact Tesla |
| `get_live_vehicle_address` | `location:read` | Live + external | One vehicle GPS read and consented reverse geocoding; street precision varies |
| `get_nearby_charging_sites` | `location:read` | Tesla/provider | Nearby site records, not live prices or free stalls |
| `reverse_trip_location` | `location:read` | External | Reverse-geocode caller-supplied coordinates; no Tesla read |
| `search_trip_destination` | `location:read` | External | OSM/Photon destination search; ambiguous candidates must be resolved |
| `get_saved_trip_places` | `location:read` | Local/private | Read saved Home/Work aliases; no Tesla favorites import |
| `set_saved_trip_place` | `location:read` | Write/private | Explicitly confirmed alias create/update/delete |
| `resolve_frequent_waypoints` | `location:read` | Local/experimental | Prepare ordered verified `refId` payload; no dispatch |
| `resolve_waypoint_places` | `location:read` | External/optional | Google Places (New) resolver for 2–16 names; consent, key and quota required |
| `get_planned_trip` | `battery:read` + `location:read` | Local/private | Retrieve a stored itinerary (up to 24 h); no dispatch or unsafe fallback |

### Energy, routing, charging data and preferences (10)

| Tool | Scope | Effect | What it does |
| --- | --- | --- | --- |
| `estimate_trip_energy` | `battery:read` | Local/estimated | Distance, capacity, consumption and reserve from supplied assumptions |
| `compare_charging_costs` | `battery:read` | Local/estimated | Two caller-supplied tariffs; no automatic personal price lookup |
| `plan_trip` | `battery:read` | Local/estimated | Combines energy and cost calculations |
| `plan_road_trip` | `location:read` | External/estimated | OSRM road route with optional stops/return; no Tesla dispatch |
| `find_charging_sites` | `location:read` | External | Area search (1–20 km), AC/DC/CCS2 filters; incomplete source coverage |
| `plan_charging_road_trip` | `location:read` | External/estimated | DC/HPC CCS2 stop optimization, battery and reserve constraints |
| `plan_smart_trip` | `battery:read` + `location:read` | External/local/estimated | Navigation-only 2–16 destinations; energy trips max 8 intermediate stops |
| `get_charging_preferences` | `battery:read` | Local/private | Read saved capacity, reserve, efficiency, charge target and map consent |
| `set_charging_preferences` | `battery:read` | Write/private | Explicitly confirmed preference updates and consent changes |
| `get_free_to_x_card_tariffs` | `battery:read` | External | Attempts official public direct-card/POS tariff retrieval; not a personal contract |

### Vehicle command execution and diagnostics (6)

| Tool | Scope | Effect | What it does |
| --- | --- | --- | --- |
| `prepare_vehicle_command` | `vehicle:control` | Staging | Validates and stages one command; does **not** dispatch |
| `execute_vehicle_command` | `vehicle:control` | Vehicle write | Executes a staged command after required confirmation |
| `execute_requested_vehicle_command` | `vehicle:control` | Vehicle write | Guarded explicitly requested direct action; no implicit user consent |
| `get_vehicle_command_status` | `vehicle:control` | Local receipt | Server journal/receipt; not proof of physical actuation |
| `start_gps_navigation_diagnostic` | `vehicle:control` | Experimental write | Explicit GPS phase A / Replace; display inspection required |
| `append_gps_navigation_diagnostic` | `vehicle:control` | Experimental write | Explicit GPS phase B / Append after separate observation |

## Full Vehicle Command operation inventory — 75 operations

All operations below originate in [`simulator/lib/operation-plans.mjs`](simulator/lib/operation-plans.mjs). Commands require the appropriate Tesla scope, MCP `vehicle:control`, explicit user intent and the configured execution gates. `Sensitive`/`ordinary` are source risk classifications. **Blocked by default** means the current pinned proxy does not implement a default transport; presence in a catalog does not override this.

<details><summary><strong>Charging (12)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `charge_start` | Start charging | — | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `charge_stop` | Stop charging | — | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `charge_standard` | Select standard charging | — | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `charge_max_range` | Select maximum range charging | — | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `set_charge_limit` | Set target state of charge | `percent` | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `set_charging_amps` | Set Charging Amps | `charging_amps` | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `set_scheduled_charging` | Set Scheduled Charging | `enable, time` | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `set_scheduled_departure` | Set Scheduled Departure | `enable, departure_time, end_off_peak_time, off_peak_charging_enabled, off_peak_charging_weekdays_only, preconditioning_enabled, preconditioning_weekdays_only` | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `add_charge_schedule` | Add Charge Schedule | `lat, lon, start_time, start_enabled, end_time, end_enabled, days_of_week, id, enabled, one_time` | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `remove_charge_schedule` | Remove Charge Schedule | `id` | `vehicle_charging_cmds` | sensitive | Implemented (gated) |
| `charge_port_door_open` | Charge Port Door Open | — | `vehicle_charging_cmds` | ordinary | Implemented (gated) |
| `charge_port_door_close` | Charge Port Door Close | — | `vehicle_charging_cmds` | ordinary | Implemented (gated) |

</details>

<details><summary><strong>Climate (16)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `add_precondition_schedule` | Add Precondition Schedule | `lat, lon, precondition_time, days_of_week, id, one_time, enabled` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remove_precondition_schedule` | Remove Precondition Schedule | `id` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `auto_conditioning_start` | Auto Conditioning Start | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `auto_conditioning_stop` | Auto Conditioning Stop | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `set_temps` | Set Temps | `driver_temp, passenger_temp` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remote_seat_heater_request` | Remote Seat Heater Request | `seat_position, level` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remote_seat_cooler_request` | Remote Seat Cooler Request | `seat_position, seat_cooler_level` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remote_auto_seat_climate_request` | Remote Auto Seat Climate Request | `auto_seat_position, auto_climate_on` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remote_steering_wheel_heater_request` | Remote Steering Wheel Heater Request | `on` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remote_auto_steering_wheel_heat_climate_request` | Set automatic steering-wheel climate | `on` | `vehicle_cmds` | ordinary | **Blocked by default** |
| `remote_steering_wheel_heat_level_request` | Set steering-wheel heat level | `level` | `vehicle_cmds` | ordinary | **Blocked by default** |
| `set_bioweapon_mode` | Enable or disable Bioweapon Defense Mode | `on, manual_override` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `set_preconditioning_max` | Enable or disable maximum preconditioning | `on, manual_override` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `set_climate_keeper_mode` | Set Climate Keeper Mode | `climate_keeper_mode` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `set_cop_temp` | Set cabin overheat protection temperature | `cop_temp` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `set_cabin_overheat_protection` | Set Cabin Overheat Protection | `on, fan_only` | `vehicle_cmds` | ordinary | Implemented (gated) |

</details>

<details><summary><strong>Navigation (4)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `navigation_gps_request` | Navigate via experimental GPS points transport | `points` | `vehicle_cmds` | ordinary | **Blocked by default** |
| `navigation_sc_request` | Navigate to a Tesla Supercharger by verified site ID | `site_id` | `vehicle_cmds` | ordinary | **Blocked by default** |
| `navigation_waypoints_request` | Navigate via ordered native waypoints | `waypoints` | `vehicle_cmds` | ordinary | **Blocked by default** |
| `navigation_request` | Navigation Request | `destination` | `vehicle_cmds` | ordinary | Implemented (gated) |

</details>

<details><summary><strong>Access (5)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `door_lock` | Lock vehicle doors | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `door_unlock` | Unlock vehicle doors | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `trigger_homelink` | Trigger Homelink | `lat, lon` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `window_control` | Window Control | `command` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `actuate_trunk` | Operate selected trunk or frunk | `which_trunk` | `vehicle_cmds` | sensitive | Implemented (gated) |

</details>

<details><summary><strong>Security (19)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `clear_pin_to_drive_admin` | Clear PIN-to-Drive using admin permissions | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `reset_pin_to_drive_pin` | Reset PIN-to-Drive PIN | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `reset_valet_pin` | Reset Valet PIN | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `parental_controls_activate` | Parental Controls Activate | `pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `parental_controls_clear_pin_admin` | Clear parental controls PIN using admin permissions | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `parental_controls_deactivate` | Parental Controls Deactivate | `pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `parental_controls_enable_setting` | Parental Controls Enable Setting | `setting, enable` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `parental_controls_set_speed_limit` | Parental Controls Set Speed Limit | `limit_mph` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `set_pin_to_drive` | Set PIN To Drive | `on, pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `set_valet_mode` | Set Valet Mode | `on, pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `speed_limit_activate` | Speed Limit Activate | `pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `speed_limit_deactivate` | Speed Limit Deactivate | `pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `speed_limit_clear_pin` | Speed Limit Clear PIN | `pin` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `speed_limit_clear_pin_admin` | Clear speed-limit PIN using admin permissions | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `erase_user_data` | Erase vehicle user data | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `set_sentry_mode` | Set Sentry Mode | `on` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `guest_mode` | Guest Mode | `enable` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `remote_start_drive` | Request remote drive authorization | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `speed_limit_set_limit` | Speed Limit Set Limit | `limit_mph` | `vehicle_cmds` | sensitive | Implemented (gated) |

</details>

<details><summary><strong>Vehicle (6)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `sun_roof_control` | Operate a compatible sunroof | `state` | `vehicle_cmds` | sensitive | **Blocked by default** |
| `upcoming_calendar_entries` | Send upcoming calendar entries | — | `vehicle_cmds` | ordinary | **Blocked by default** |
| `set_low_power_mode` | Set Low Power Mode | `enable` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `keep_accessory_power_mode` | Keep Accessory Power Mode | `enable` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `wake_up` | Request an explicit vehicle wake | — | `vehicle_cmds` | sensitive | Implemented (gated) |
| `set_vehicle_name` | Set Vehicle Name | `vehicle_name` | `vehicle_cmds` | ordinary | Implemented (gated) |

</details>

<details><summary><strong>Signals (3)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `flash_lights` | Flash Lights | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `honk_horn` | Honk Horn | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `remote_boombox` | Request a Boombox sound | `sound_id` | `vehicle_cmds` | sensitive | **Blocked by default** |

</details>

<details><summary><strong>Media (8)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `media_toggle_playback` | Media Toggle Playback | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `media_next_track` | Media Next Track | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `media_prev_track` | Media Prev Track | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `adjust_volume` | Adjust Volume | `volume` | `vehicle_cmds` | ordinary | Implemented (gated) |
| `media_volume_up` | Media Volume Up | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `media_volume_down` | Media Volume Down | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `media_next_fav` | Media Next Fav | — | `vehicle_cmds` | ordinary | Implemented (gated) |
| `media_prev_fav` | Media Prev Fav | — | `vehicle_cmds` | ordinary | Implemented (gated) |

</details>

<details><summary><strong>Software (2)</strong></summary>

| Tesla operation | Request / purpose | Allowed parameters | Required Tesla scope | Risk | Current transport |
| --- | --- | --- | --- | --- | --- |
| `schedule_software_update` | Schedule Software Update | `offset_sec` | `vehicle_cmds` | sensitive | Implemented (gated) |
| `cancel_software_update` | Cancel Software Update | — | `vehicle_cmds` | sensitive | Implemented (gated) |

</details>

**Code sources of truth:** [`real-mcp.mjs`](simulator/lib/real-mcp.mjs) (MCP discovery/dispatch), [`tesla.mjs`](simulator/lib/tesla.mjs) (Fleet API reads), [`operation-plans.mjs`](simulator/lib/operation-plans.mjs) (75 command definitions and transport gates). These are maintained independently by each installer in their own deployment.

## Evidence and release maintenance

- Source-present, offline-tested, developer-reported real-vehicle tested, Tesla API accepted and independently vehicle-observed are **different evidence levels**.
- The developer reports testing all 75 operations on a real Tesla; the exact revision, configuration and per-operation logs are not independently audited here. Eight SDK transports remain unavailable by default.
- Navigation-only planning supports 2–16 ordered destinations; independent proof of on-screen route delivery for every vehicle/firmware is not supplied. No automatic wake or blind command retry.
- Update this file for each future change with the **date, precise tool/operation, Tesla endpoint, behavior, authorization, tests, and PR/commit**; don't invent individual first-implementation dates.

Related: [Features](docs/FEATURES.md) · [Tool schemas](docs/TOOLS_REFERENCE.md) · [Security model](docs/SECURITY_MODEL.md) · [Evidence](docs/EVIDENCE.md).

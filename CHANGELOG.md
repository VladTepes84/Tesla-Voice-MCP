# Changelog & Tesla API / command reference

**Tesla Voice MCP — public open-source repository** · **Last updated: 19 November 2026**

[README](README.md) · [Tesla API endpoints](#tesla-fleet-api-endpoints) · [All 40 MCP tools](#all-mcp-tools-40) · [All 75 vehicle operations](#all-vehicle-operations-75) · [Evidence and limitations](#evidence-costs-and-operational-limits)

This document is both a **dated changelog** and a **source-backed index** of the capabilities available in this independently self-hosted project. It distinguishes **MCP tools** (AI-callable interfaces), **Tesla Fleet API requests**, **local calculations**, **third-party lookups** and **vehicle commands**. The catalog does **not** imply that all features are available for every car or AI client.

## Release history

### 2026-11-19 — Tesla Service History integration

**Added to the public `main` branch:** [PR #4](https://github.com/VladTepes84/Tesla-Voice-MCP/pull/4), merged in [commit `9555238`](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/9555238c163874c82aaf1c69290970fdb7587fc7).

- **`get_service_history`** → `GET /api/1/vehicles/{VIN}/service_history?page={page}&per_page={per_page}`. Lists the current owner's completed Tesla visits, newest first. Supports `page`, `per_page` (1–50), `pagination.next` and within-page ID deduplication. Clients reading multiple pages should deduplicate visit IDs across page boundaries.
- **`get_service_visit_details`** → `GET /api/1/vehicles/{VIN}/service_history/{service_visit_id}`. Reads a specific visit's available work items, descriptions, correction codes, payment types and allowlisted invoice fields. Costs may be unavailable for warranty or non-invoiced work.
- **Authorization and privacy:** both are read-only; MCP `battery:read` and Tesla `vehicle_device_data` are required. Both use the existing Tesla-request budget. Neither performs `wake_up`, polling, command dispatch or automatic retry. The implementation validates IDs and pagination, limits exposed response fields and categorizes 403/404/503 errors.
- **Offline release verification:** 541/541 Node tests, Go test/build/vet and Gitleaks on the PR's verified final head. [Node/Go/Redis CI](https://github.com/VladTepes84/Tesla-Voice-MCP/actions/runs/44491582074) · [Gitleaks](https://github.com/VladTepes84/Tesla-Voice-MCP/actions/runs/44491582046). **No real vehicle Service History access, voice end-to-end test or public hosting deploy** was established by that CI.

Tesla officially announced **`service_history`**, **service-visit details** and **`vehicle_data_cached`** on **11 November 2026**. The **Tesla announcement date** and this repository's **19 November integration date** are different. The cached-data endpoint was already implemented in this project before the Service History merge. [Official Tesla announcement](https://developer.tesla.com/docs/fleet-api/announcements).

### 2026-11-18 — Public repository support

- Added optional GitHub Sponsors information to the public README; no vehicle-command behavior was changed. [Commit](https://github.com/VladTepes84/Tesla-Voice-MCP/commit/92d35ccacd56ec6fb648bcee9a6189cfc13fb616).

### 2026-11-17 — Documentation and test evidence

- Published the [developer-reported vehicle testing record](docs/REAL_VEHICLE_TESTING.md) distinguishing a historical declaration from independently auditable evidence. [PR #3](https://github.com/VladTepes84/Tesla-Voice-MCP/pull/3).
- Documented a [credential-free, synthetic MCP onboarding smoke test](docs/CLEAN_ROOM_SMOKE.md). This verifies an offline integration path, not a Tesla account, AI-client voice compatibility or a production deployment.

### Existing capabilities — original implementation dates not established

The other **38 MCP tools** and the **75 operation names** existed in the source-backed baseline before the 19 November Service History addition. Their original introduction dates have **not been reconstructed from the entire commit history**. They appear in the inventories below without falsely assigning their implementation to 17, 18 or 19 November.

## Tesla Fleet API endpoints

These paths are taken from the **public** source [`simulator/lib/tesla.mjs`](simulator/lib/tesla.mjs) and [`simulator/api/tesla-command-proxy.go`](simulator/api/tesla-command-proxy.go). `{VIN}` and `{service_visit_id}` are generic placeholders, never real account identifiers.

| Tesla endpoint / method | Called by | Behavior and boundary |
| --- | --- | --- |
| `GET /api/1/vehicles/{VIN}/vehicle_data_cached` | `get_battery`, `get_vehicle_status` | Fetches Tesla's last cached charge/vehicle status. **API request, no vehicle wake**; may be stale |
| `GET /api/1/vehicles/{VIN}/vehicle_data?endpoints=charge_state;climate_state;vehicle_state` | `get_live_vehicle_data` | One on-demand vehicle-state read; may contact vehicle, use quota, fail while asleep |
| `GET /api/1/vehicles/{VIN}/vehicle_data?endpoints=location_data` | `get_vehicle_location`, `get_live_vehicle_address` | Reads GPS/route data. The address tool additionally uses consented external geocoding |
| `GET /api/1/vehicles/{VIN}/vehicle_data?endpoints=charge_schedule_data;preconditioning_schedule_data` | `get_vehicle_schedules` | Reads native charging and preconditioning schedules |
| `GET /api/1/vehicles/{VIN}` | `get_vehicle_connectivity` | Reads Tesla-reported online/asleep/offline connectivity |
| `GET /api/1/vehicles/{VIN}/mobile_enabled` | `get_vehicle_mobile_access` | Reads whether mobile access is enabled |
| `GET /api/1/vehicles/{VIN}/nearby_charging_sites?detail=true` | `get_nearby_charging_sites` | Retrieves Tesla nearby site records, not guaranteed live stall occupancy or tariffs |
| `GET /api/1/vehicles/{VIN}/service_history?page={page}&per_page={per_page}` | **`get_service_history`** | Current owner's completed visits; added 19 November |
| `GET /api/1/vehicles/{VIN}/service_history/{service_visit_id}` | **`get_service_visit_details`** | Work items and returned costs for a selected visit; added 19 November |
| `GET /api/1/dx/charging/history` (VIN/time query) | `get_charging_history` | Session-history endpoint; Tesla documents account eligibility restrictions; not a universal owner invoice |
| `POST /api/1/vehicles/{VIN}/command/{operation}` | Most guarded vehicle writes | Official signed-command proxy path for supported operation names; compatibility and permissions vary |
| `POST /api/1/vehicles/{VIN}/command/navigation_request` | `navigation_request` | Explicit single-destination REST pass-through; acceptance does not prove route display |
| `POST /api/1/vehicles/{VIN}/wake_up` | `wake_up` only | Explicit REST wake-up, **not** a signed command; no automatic wake on cached reads |
| Tesla `/oauth2/v3/token` (separate auth host) | `connect_tesla`, token refresh | OAuth code exchange and token refresh; distinct from MCP client OAuth |

**Important:** `vehicle_data_cached` avoids waking the car, but it is still a request to Tesla's servers and subject to the application's request budget or provider billing. The project does not equate cached access with a zero-cost local Redis lookup. App reading history and saved preferences are local/private-store features, not additional Tesla history APIs.

Official references: [Fleet API announcement](https://developer.tesla.com/docs/fleet-api/announcements) · [Vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints) · [Vehicle commands](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands) · [Charging endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/charging-endpoints) · [Authentication and scopes](https://developer.tesla.com/docs/fleet-api/authentication/overview).

## All MCP tools (40)

A **tool** is an AI-facing entry point, not necessarily a direct Tesla API method. Scopes shown here are **MCP scopes**; Tesla OAuth scopes are separate. Tool visibility depends on flags, permissions and provider configuration. Refer to the deployed `tools/list` `inputSchema` for exact call arguments.

### Authentication, connection and permissions (4)

4 MCP tools — scopes, call type and behavior, as defined in [TOOLS_REFERENCE](docs/TOOLS_REFERENCE.md).

| MCP tool | MCP scope | Effect | What it returns / does |
| --- | --- | --- | --- |
| `connect_tesla` | `tesla:connect` | Tesla OAuth linking | Explicitly initiated linking; not a token export |
| `get_connection_status` | `battery:read` | Local | Link state, scopes, gates and request budget; no vehicle contact |
| `prepare_vehicle_command_setup` | `tesla:connect` | Setup assistance | Virtual-key and partner prerequisites; not an implicit registration |
| `get_vehicle_command_catalog` | `battery:read` | Local | Operation names, parameter schemas, scopes and current dispatch availability |

### Vehicle readings, charging, service and connectivity (10)

10 MCP tools — scopes, call type and behavior, as defined in [TOOLS_REFERENCE](docs/TOOLS_REFERENCE.md).

| MCP tool | MCP scope | Effect | What it returns / does |
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

10 MCP tools — scopes, call type and behavior, as defined in [TOOLS_REFERENCE](docs/TOOLS_REFERENCE.md).

| MCP tool | MCP scope | Effect | What it returns / does |
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

10 MCP tools — scopes, call type and behavior, as defined in [TOOLS_REFERENCE](docs/TOOLS_REFERENCE.md).

| MCP tool | MCP scope | Effect | What it returns / does |
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

6 MCP tools — scopes, call type and behavior, as defined in [TOOLS_REFERENCE](docs/TOOLS_REFERENCE.md).

| MCP tool | MCP scope | Effect | What it returns / does |
| --- | --- | --- | --- |
| `prepare_vehicle_command` | `vehicle:control` | Staging | Validates and stages one command; does **not** dispatch |
| `execute_vehicle_command` | `vehicle:control` | Vehicle write | Executes a staged command after required confirmation |
| `execute_requested_vehicle_command` | `vehicle:control` | Vehicle write | Guarded explicitly requested direct action; no implicit user consent |
| `get_vehicle_command_status` | `vehicle:control` | Local receipt | Server journal/receipt; not proof of physical actuation |
| `start_gps_navigation_diagnostic` | `vehicle:control` | Experimental write | Explicit GPS phase A / Replace; display inspection required |
| `append_gps_navigation_diagnostic` | `vehicle:control` | Experimental write | Explicit GPS phase B / Append after separate observation |

## All vehicle operations (75)

The **75 command operation names are not 75 additional MCP tools**. They are command definitions exposed by `get_vehicle_command_catalog` and dispatched only through the appropriate, guarded command tools. This inventory is **derived directly from `simulator/lib/operation-plans.mjs`**, not from a claim that all operations work on every Tesla.

The standard transport for a supported operation is the vehicle-command proxy targeting `POST /api/1/vehicles/{VIN}/command/{operation}`. `navigation_request` uses REST pass-through, `wake_up` uses a separate REST endpoint, and certain waypoint/GPS modes have separately gated experimental transports. **All operations require explicit user intent** and the MCP `vehicle:control` permission in addition to their Tesla scope.

### Charging (12)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `charge_start` | Charge start | `vehicle_charging_cmds` | Signed-command proxy |
| `charge_stop` | Charge stop | `vehicle_charging_cmds` | Signed-command proxy |
| `charge_standard` | Request standard charging mode | `vehicle_charging_cmds` | Signed-command proxy |
| `charge_max_range` | Request maximum-range charging mode | `vehicle_charging_cmds` | Signed-command proxy |
| `set_charge_limit` | Set charging state-of-charge limit | `vehicle_charging_cmds` | Signed-command proxy |
| `set_charging_amps` | Set maximum charging current | `vehicle_charging_cmds` | Signed-command proxy |
| `set_scheduled_charging` | Set scheduled charging parameters | `vehicle_charging_cmds` | Signed-command proxy |
| `set_scheduled_departure` | Set scheduled departure parameters | `vehicle_charging_cmds` | Signed-command proxy |
| `add_charge_schedule` | Add charge schedule | `vehicle_charging_cmds` | Signed-command proxy |
| `remove_charge_schedule` | Remove charge schedule | `vehicle_charging_cmds` | Signed-command proxy |
| `charge_port_door_open` | Open the charging port door | `vehicle_charging_cmds` | Signed-command proxy |
| `charge_port_door_close` | Close the charging port door | `vehicle_charging_cmds` | Signed-command proxy |

### Climate and temperature (16)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `add_precondition_schedule` | Add precondition schedule | `vehicle_cmds` | Signed-command proxy |
| `remove_precondition_schedule` | Remove precondition schedule | `vehicle_cmds` | Signed-command proxy |
| `auto_conditioning_start` | Start cabin climate | `vehicle_cmds` | Signed-command proxy |
| `auto_conditioning_stop` | Stop cabin climate | `vehicle_cmds` | Signed-command proxy |
| `set_temps` | Set cabin temperatures | `vehicle_cmds` | Signed-command proxy |
| `remote_seat_heater_request` | Remote seat heater request | `vehicle_cmds` | Signed-command proxy |
| `remote_seat_cooler_request` | Remote seat cooler request | `vehicle_cmds` | Signed-command proxy |
| `remote_auto_seat_climate_request` | Configure automatic seat climate | `vehicle_cmds` | Signed-command proxy |
| `remote_steering_wheel_heater_request` | Remote steering wheel heater request | `vehicle_cmds` | Signed-command proxy |
| `remote_auto_steering_wheel_heat_climate_request` | Configure automatic steering-wheel heating | `vehicle_cmds` | Unavailable by default* |
| `remote_steering_wheel_heat_level_request` | Remote steering wheel heat level request | `vehicle_cmds` | Unavailable by default* |
| `set_bioweapon_mode` | Control Bioweapon Defense Mode when equipped | `vehicle_cmds` | Signed-command proxy |
| `set_preconditioning_max` | Set preconditioning max | `vehicle_cmds` | Signed-command proxy |
| `set_climate_keeper_mode` | Set climate keeper mode | `vehicle_cmds` | Signed-command proxy |
| `set_cop_temp` | Set cabin-overheat-protection temperature | `vehicle_cmds` | Signed-command proxy |
| `set_cabin_overheat_protection` | Control cabin overheat protection | `vehicle_cmds` | Signed-command proxy |

### Access and body controls (5)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `door_lock` | Door lock | `vehicle_cmds` | Signed-command proxy |
| `door_unlock` | Door unlock | `vehicle_cmds` | Signed-command proxy |
| `trigger_homelink` | Trigger configured HomeLink device | `vehicle_cmds` | Signed-command proxy |
| `window_control` | Window control | `vehicle_cmds` | Signed-command proxy |
| `actuate_trunk` | Actuate trunk or front trunk | `vehicle_cmds` | Signed-command proxy |

### Lights, horn and Boombox (3)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `flash_lights` | Flash lights | `vehicle_cmds` | Signed-command proxy |
| `honk_horn` | Honk horn | `vehicle_cmds` | Signed-command proxy |
| `remote_boombox` | Trigger remote Boombox if supported | `vehicle_cmds` | Unavailable by default* |

### Security and driving restrictions (19)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `clear_pin_to_drive_admin` | Clear PIN to Drive with admin authorization | `vehicle_cmds` | Signed-command proxy |
| `reset_pin_to_drive_pin` | Reset PIN to Drive credential | `vehicle_cmds` | Signed-command proxy |
| `reset_valet_pin` | Reset Valet PIN | `vehicle_cmds` | Signed-command proxy |
| `parental_controls_activate` | Parental controls activate | `vehicle_cmds` | Signed-command proxy |
| `parental_controls_clear_pin_admin` | Admin-clear parental controls PIN | `vehicle_cmds` | Signed-command proxy |
| `parental_controls_deactivate` | Parental controls deactivate | `vehicle_cmds` | Signed-command proxy |
| `parental_controls_enable_setting` | Parental controls enable setting | `vehicle_cmds` | Signed-command proxy |
| `parental_controls_set_speed_limit` | Parental controls set speed limit | `vehicle_cmds` | Signed-command proxy |
| `set_pin_to_drive` | Enable/disable PIN to Drive | `vehicle_cmds` | Signed-command proxy |
| `set_valet_mode` | Enable/disable Valet Mode | `vehicle_cmds` | Signed-command proxy |
| `speed_limit_activate` | Speed limit activate | `vehicle_cmds` | Signed-command proxy |
| `speed_limit_deactivate` | Speed limit deactivate | `vehicle_cmds` | Signed-command proxy |
| `speed_limit_clear_pin` | Speed limit clear pin | `vehicle_cmds` | Signed-command proxy |
| `speed_limit_clear_pin_admin` | Speed limit clear pin admin | `vehicle_cmds` | Signed-command proxy |
| `erase_user_data` | Erase supported user data (sensitive) | `vehicle_cmds` | Signed-command proxy |
| `set_sentry_mode` | Set sentry mode | `vehicle_cmds` | Signed-command proxy |
| `guest_mode` | Configure Guest Mode | `vehicle_cmds` | Signed-command proxy |
| `remote_start_drive` | Authorize remote start/drive (sensitive) | `vehicle_cmds` | Signed-command proxy |
| `speed_limit_set_limit` | Speed limit set limit | `vehicle_cmds` | Signed-command proxy |

### Navigation (4)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `navigation_gps_request` | Experimental GPS-coordinate navigation | `vehicle_cmds` | Unavailable by default* |
| `navigation_sc_request` | Experimental native Supercharger navigation | `vehicle_cmds` | Unavailable by default* |
| `navigation_waypoints_request` | Experimental waypoint navigation | `vehicle_cmds` | Unavailable by default* |
| `navigation_request` | Send one destination to Tesla navigation | `vehicle_cmds` | REST pass-through |

### Vehicle power and identity (6)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `sun_roof_control` | Request sunroof control when supported | `vehicle_cmds` | Unavailable by default* |
| `upcoming_calendar_entries` | Read upcoming calendar entries where supported | `vehicle_cmds` | Unavailable by default* |
| `set_low_power_mode` | Configure low-power mode | `vehicle_cmds` | Signed-command proxy |
| `keep_accessory_power_mode` | Configure retained accessory power | `vehicle_cmds` | Signed-command proxy |
| `wake_up` | Explicitly request vehicle wake-up; never automatic | `vehicle_cmds` | REST wake-up |
| `set_vehicle_name` | Set vehicle name | `vehicle_cmds` | Signed-command proxy |

### Software updates (2)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `schedule_software_update` | Schedule software update | `vehicle_cmds` | Signed-command proxy |
| `cancel_software_update` | Cancel software update | `vehicle_cmds` | Signed-command proxy |

### Media (8)

| Operation | What it does | Tesla authorization | Transport in default configuration |
| --- | --- | --- | --- |
| `media_toggle_playback` | Toggle playback | `vehicle_cmds` | Signed-command proxy |
| `media_next_track` | Next track | `vehicle_cmds` | Signed-command proxy |
| `media_prev_track` | Previous track | `vehicle_cmds` | Signed-command proxy |
| `adjust_volume` | Adjust media volume | `vehicle_cmds` | Signed-command proxy |
| `media_volume_up` | Increase volume | `vehicle_cmds` | Signed-command proxy |
| `media_volume_down` | Decrease volume | `vehicle_cmds` | Signed-command proxy |
| `media_next_fav` | Next favorite | `vehicle_cmds` | Signed-command proxy |
| `media_prev_fav` | Previous favorite | `vehicle_cmds` | Signed-command proxy |

**\* Unavailable by default in the pinned SDK/proxy (8):** `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request`, `sun_roof_control`, `upcoming_calendar_entries`, `remote_boombox`, `remote_auto_steering_wheel_heat_climate_request`, `remote_steering_wheel_heat_level_request`. Some navigation requests have experimental alternatives under special gates. Thus, **67 default software transport paths** is a source-code count, **not** a guarantee of 67 working operations for every vehicle. See [Features](docs/FEATURES.md) and the runtime `get_vehicle_command_catalog` response for exact status, arguments and support.

## Evidence, costs and operational limits

- **Self-hosted public software:** each operator supplies their own Tesla application, Tesla OAuth approval, MCP OAuth, HTTPS host, encrypted store, command key/pairing and any optional map providers. Downloading this public repository does **not** require any maintainer-owned deployment, private backend or personal credentials.
- **Safety by intent:** no implicit `wake_up`, route dispatch, command retry or background polling. Prepared itineraries are not sent to the vehicle. If command outcome is uncertain, inspect the receipt and separately verify vehicle state instead of blindly retrying.
- **Planning vs execution:** navigation-only plans accept 2–16 ordered destinations; energy-planning mode accepts up to eight intermediate stops. Native waypoint and GPS Replace/Append paths remain experimental/gated; API `accepted` does not establish all stops on the Tesla screen.
- **Costs:** Fleet API and some external integrations are metered. Hosting, Redis, AI-client subscriptions and optional Google Places may incur charges. A production request budget may be configured as unlimited; the operator must set sensible provider-side spend and quota limits.
- **Evidence:** `IMPLEMENTED` means source exists; `VERIFIED_OFFLINE` means controlled tests passed; `DEVELOPER_REPORTED` describes a historical claim, not independent proof; `PROVIDER_ACCEPTED` is not `VEHICLE_VERIFIED`. The exact vehicle firmware, software revision and per-operation evidence for the developer's October 2026 testing statement are not recorded.
- **Privacy:** never commit tokens, vehicle identifiers, private locations, personal charging contracts or historical vehicle data. Review [Security](docs/SECURITY_MODEL.md) and [Evidence](docs/EVIDENCE.md) before enabling commands.

**Further documentation:** [Installation](docs/INSTALLATION.md) · [Complete MCP tool reference](docs/TOOLS_REFERENCE.md) · [Feature catalog](docs/FEATURES.md) · [Developer test record](docs/REAL_VEHICLE_TESTING.md) · [Architecture](docs/ARCHITECTURE.md).

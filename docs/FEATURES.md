# Complete feature catalog

## What this catalog represents

The implementation exposes **40 named MCP tools** across the five major reference groups, plus **75 operation names** in the separate Tesla command catalog. Not all MCP tools appear simultaneously: runtime feature gates and OAuth scopes control discovery and invocation. The count is a **code inventory**; separately, the developer confirms all 75 operations were successfully tested on their real Tesla, without an independent audit or documented exact revision.

| Added layer | Why it matters to a user | Source / evidence |
| --- | --- | --- |
| Assistant-facing tool interface | Natural-language requests can invoke typed, discoverable MCP tools | `simulator/lib/real-mcp.mjs`; compatible client required |
| Context and provenance | Cached/live distinctions, timestamps and app-collected samples | Tesla/store modules; no continuous polling guarantee |
| Trip and charging logic | Reserve calculations, mapped stations, CCS2 corridors and tariff comparisons | Road-trip/charging/energy modules; estimated outcomes |
| Multi-destination preparation | Explicit ordering and ambiguity handling for 2–16 navigation-only stops | Smart-trip and waypoint modules; developer reports real-car navigation up to 16 destinations, independently unverified |
| Command lifecycle and policy | Scoped, allowlisted, gated writes with receipts | Command and security modules; physical result separately verified |

The project does **not** add privileged Tesla vehicle capabilities or guarantee that an AI client supports every operation. See [Why MCP](WHY_MCP.md), [Workflows](WORKFLOWS.md) and [Evidence](EVIDENCE.md).


**Scope:** This repository's sanitized source and current release candidate; verify the deployed commit and live `tools/list` before relying on this inventory. This is a **code inventory, not an end-to-end test or a guarantee of Tesla/AI-client compatibility**. The available `tools/list` response changes according to the operator's environment variables and permissions.

## How to read the status

**AI platform independence:** These are MCP tool capabilities offered by your server, not built-in ChatGPT features. They are intended to be available to compatible **ChatGPT, Claude, Gemini, Grok and other AI clients**, subject to separate OAuth/transport/tool-permission checks. Integration with those clients is **expected, not independently end-to-end verified** by this repository. Voice invocation must be checked on the chosen AI mode separately.

**Integrations:** [AI client setup](AI_CLIENTS.md) · [Voice](VOICE_USAGE.md) · [Google Places / Place ID](GOOGLE_PLACES_SETUP.md) · [Maps](MAP_PROVIDERS.md).



- **IMPLEMENTED (source):** a tool, parser or backend path exists in the repository. Nothing here implies live validation.
- **GATED:** code exists but the feature is hidden or refused until explicit configuration, OAuth scope and/or Tesla registration is complete.
- **SIMULATED / ESTIMATED:** generated from mock data or supplied assumptions; it is not live data or a command to the car.
- **EXPERIMENTAL:** a proposed transport or integration has special safeguards and may be disabled, partial, unavailable or unverified on a vehicle.
- **UNAVAILABLE BY DEFAULT:** the pinned SDK/proxy lacks a supported transport path until a specific experimental gate applies; the catalog may still describe it.

**Privacy:** examples below contain no account-specific configuration, actual VIN, Tesla token, private address, password or live location.

## 1. Tesla authorization and connection

| MCP tool | What it does | Important boundaries |
| --- | --- | --- |
| `connect_tesla` | Creates a short-lived Tesla OAuth linking flow when explicitly requested; stores account authorization separately from MCP client authentication. | Not an automatic reconnect or token export; checks current connection first. |
| `get_connection_status` | Reports whether account linking, scopes, feature gates and application request budget are ready. | Reads server state; does not contact or wake a vehicle. |
| `prepare_vehicle_command_setup` | Guides the virtual-key / partner-registration prerequisites for signed vehicle actions. | Registration and pairing require Tesla-side authorization and may use API quota or incur charges. |
| `get_vehicle_command_catalog` | Enumerates allowed command names, arguments, Tesla scopes and whether dispatch is currently enabled. | A listed command is not proof that the vehicle supports or completed it. |

### Authentication is layered

1. **MCP client → server:** a remote client sends a signed JWT to `/mcp`; the server validates issuer, audience, subject, expiry and per-tool scopes.
2. **Server → Tesla:** the owner's separate Tesla OAuth connection authorizes Fleet API resources and vehicle scopes.
3. **Signed actions:** command operations can require a virtual key and independently enabled execution gates.
4. **Persistence:** tokens and private user information are stored in a configured Redis REST store with server-side encryption. A separate operator should run a separate instance.

The MCP access token is **not** the Tesla access token. A user must never paste either token into a public chat, repository or issue.

## 2. Vehicle and battery readings

| MCP tool | What it does | Freshness / side effects |
| --- | --- | --- |
| `get_battery` | Reads battery level, range, charging and related available state from the latest cached Tesla snapshot; records an application sample. | **Cached**, includes timestamp, no direct Tesla request or wake. |
| `get_vehicle_status` | Cached climate, locks/Sentry, odometer, charging and software status where provided. | **Cached** and possibly stale. |
| `get_live_vehicle_data` | Requests a **single** live reading including battery and other available vehicle fields, possibly tire pressure. | May contact or wake the car; uses quota. No automatic retry or silent cached fallback. |
| `get_vehicle_reading_history` | Shows samples the server collected during previous requested reads, within a 31-day window. | Not Tesla's full historical telemetry; no polling background service. |
| `get_vehicle_connectivity` | Queries the backend connectivity status. | Availability and freshness are limited by Tesla responses. |
| `get_vehicle_mobile_access` | Retrieves the mobile access-related connectivity result when supported. | Does not itself command the vehicle. |
| `get_charging_history` | Requests recent Tesla charging sessions (up to 31 days) and returned session properties. | Historic, not a live meter or universal invoice ledger. |
| `get_service_history` | Reads one page of the current owner’s completed Tesla service visits, newest first. | Uses Tesla Fleet API and `vehicle_device_data`; page through `pagination.next`, deduplicating visit IDs across pages; excludes previous owners’ visits. |
| `get_service_visit_details` | Reads available correction codes, work description, warranty/payment type and final invoice totals for a service visit. | May return no work items or costs; limited to IDs returned for this vehicle; no command or wake. |
| `get_vehicle_schedules` | Reads native charge and preconditioning schedules. | A live Tesla read; **does not modify** schedules. |

## 3. Vehicle location, addresses and nearby chargers

| MCP tool | What it does | Boundary |
| --- | --- | --- |
| `get_vehicle_location` | Live GPS plus available active destination, ETA, arrival-charge prediction and reserve comparison. | Location OAuth scope; can expose sensitive location; may contact the car and use quota. |
| `get_live_vehicle_address` | Reads one GPS position and resolves a spoken street/municipality using permitted public map providers. | Requires external map consent. Address/civic precision is not guaranteed; avoids returning raw coordinates. |
| `get_nearby_charging_sites` | Asks Tesla for nearby Superchargers/chargers near the vehicle, with details where available. | Area is sensitive; output does **not** establish live tariffs or stall availability. |
| `reverse_trip_location` | Turns explicitly supplied coordinates into a human-readable OSM/Photon result. | Requires map consent; **does not** read Tesla. |
| `search_trip_destination` | Searches names and addresses with Photon/OSM and bounded Nominatim fallback; preserves ambiguous candidates. | Requires consent; never publicly geocodes an unconfigured private Home/Work alias. |
| `get_saved_trip_places` | Retrieves the private Home/Work aliases previously confirmed by this operator. | No Tesla favorites import, live GPS, public lookup or command. |
| `set_saved_trip_place` | Adds, updates or deletes one private Home/Work entry after explicit confirmation. | Account-private encrypted storage; user must verify the coordinates or Place ID. |
| `resolve_frequent_waypoints` | Resolves locally configured, verified names to an ordered native `refId` waypoint payload. | **Preparation only**, no Tesla dispatch; requires its navigation gate and verified private catalog. |
| `resolve_waypoint_places` | Optional Google Places (New) resolver for 2–16 ordered named destinations, with choice for ambiguous results. | Requires operator Google key, enabled production gate, consent and quotas; **does not send** a route to Tesla. |

## 4. Trip calculations and planning

| MCP tool | What it calculates | Limitations |
| --- | --- | --- |
| `estimate_trip_energy` | Energy demand, estimated arrival SOC and any shortfall against an explicitly supplied battery reserve. | Caller-supplied distance/capacity/consumption; **not** a Tesla read or routing service. |
| `compare_charging_costs` | Compares two caller-supplied €/kWh + fixed-fee tariffs, including chosen charging efficiency. | Does not fetch or store a personal tariff, verify contracts, or read Tesla. |
| `plan_trip` | Combines the above energy/cost estimates into a simple calculation. | Does not identify a real route, compatible stalls, or a charging curve. |
| `plan_road_trip` | Uses OSRM road distances for origin/destination, optional stops/return, energy and reserve checks. | Routing service data may be incomplete; avoid-toll/motorway choices are best effort; does not send navigation to car. |
| `find_charging_sites` | Searches mapped stations within 1–20 km of an explicit point. Filters `AC`, `DC` or `CCS2`, using eligible OSM and national data. | Data may be incomplete/stale; an empty list does **not** prove no stations exist. AC results are local-area search only. |
| `plan_charging_road_trip` | Searches feasible **DC/HPC CCS2** stops along a route, considering battery state, reserve, charge target, maximum stops and available data. | Cost, power and station availability are conditional estimates; AC is intentionally not an automatic trip stop. No Tesla command. |
| `plan_smart_trip` | A natural-language-oriented orchestration layer for 2–16 navigation-only destinations, saved Home/Work, ambiguity resolution, charging logic and route persistence. Energy trips retain a limit of eight intermediate stops. | Requests consent for external maps and separately for Tesla location/battery when needed. Multi-destination navigation is **not automatically dispatched**. |
| `get_planned_trip` | Reads an encrypted itinerary stored by `plan_smart_trip` for up to 24 hours, with provenance and potential handoff. | It does not recalculate or send destinations; it deliberately blocks unsafe single-stop fallback from a multi-stop plan. |
| `get_charging_preferences` | Reads this account's persisted numeric efficiency/capacity/reserve/charge-target preferences and public-map consent. | Preferences are not certified measurements or Tesla data. |
| `set_charging_preferences` | Updates only user-confirmed values; map consent can be saved and revoked separately. | Does not store private retail tariffs or authorize vehicle commands. |
| `get_free_to_x_card_tariffs` | Attempts to parse the **official public direct-card/POS Free To X price list**, returning source URL and retrieval timestamp. | Not a personal contract, subscription, flat rate, station price or universal operator tariff. Failure must be reported as unavailable. |

### Charging data and calculation boundaries

- **AC area discovery** is supported through `find_charging_sites` with `connectorType: "AC"`. It is not part of the automatic DC/HPC road-trip stop optimizer.
- **Dynamic station sources** include OpenStreetMap, Italian PUN/AgID-GSE, French IRVE, German BNetzA and Swiss SFOE/ich-tanke-strom as available. Sources have different freshness, licensing, format and coverage; none guarantees an open, usable stall.
- The routing and optimizer use road distances, bounded request budgets and energy reserves. They do **not** implement Tesla's native battery-management, traffic/temperature-aware range model or a certified charging curve.
- A price comparison is meaningful only when tariffs are supplied or verified for the correct payment method, operator and date. **Never apply one operator's personal pricing to all stations.**

## 5. Remote Tesla commands

The source declares **75 operation names** in the command catalog. In the baseline default catalog, **eight SDK transports are unavailable**, leaving **67 software transport paths** that may become available when execution gates are on. These numbers describe the **current code catalog** and default transports. Separately, the developer confirms successful real-vehicle tests of all 75 operations; the tested revision and configuration are not documented, and availability is not guaranteed for every vehicle.

### Execution tools

| MCP tool | Behavior | Safety gate |
| --- | --- | --- |
| `prepare_vehicle_command` | Validates and stages one allowed command; returns a short-lived ticket/confirmation path for normal operations. | **No dispatch** until separately confirmed; some special navigation modes only produce a non-executable preview. |
| `execute_vehicle_command` | Executes a previously staged command after the correct follow-up confirmation phrase. | Command can change the vehicle; signed Tesla request and pairing required. |
| `execute_requested_vehicle_command` | Processes one explicitly requested action in the current user turn through the guarded invocation/command protocol. | Do not infer user approval from a tool description; duplicate or uncertain outcomes need receipt checks, not blind repeats. |
| `get_vehicle_command_status` | Inspects the server-side journal and receipts for a specific command attempt. | Does not interrogate the vehicle to prove physical actuation. |
| `start_gps_navigation_diagnostic` | Experimental GPS route diagnostic phase A (`Replace` only). | Requires explicit user request, special gate and later physical display inspection. |
| `append_gps_navigation_diagnostic` | Experimental diagnostic phase B (`Append` only), after confirmed observation of phase A. | Separate explicit user confirmation; no implicit retries or concatenation into a guaranteed route. |

### Command groups represented in `simulator/lib/operation-plans.mjs`

The catalog exposes parameter schemas and per-operation required Tesla scopes; vehicle support remains model/firmware-dependent. **These lists do not constitute permission to run the commands.**

| Group | Operation names in source | Notes |
| --- | --- | --- |
| Charging | `charge_start`, `charge_stop`, `charge_standard`, `charge_max_range`, `set_charge_limit`, `set_charging_amps`, `set_scheduled_charging`, `set_scheduled_departure`, `add_charge_schedule`, `remove_charge_schedule`, `charge_port_door_open`, `charge_port_door_close` | Live writes require charge-command scopes and vehicle support. |
| Climate | `add_precondition_schedule`, `remove_precondition_schedule`, `auto_conditioning_start`, `auto_conditioning_stop`, `set_temps`, `remote_seat_heater_request`, `remote_seat_cooler_request`, `remote_auto_seat_climate_request`, `remote_steering_wheel_heater_request`, `remote_auto_steering_wheel_heat_climate_request`, `remote_steering_wheel_heat_level_request`, `set_bioweapon_mode`, `set_preconditioning_max`, `set_climate_keeper_mode`, `set_cop_temp`, `set_cabin_overheat_protection` | Hardware-specific operations may be inapplicable. Two wheel/climate transports are unavailable in the pinned SDK. |
| Access and signals | `door_lock`, `door_unlock`, `trigger_homelink`, `window_control`, `actuate_trunk`, `flash_lights`, `honk_horn`, `remote_boombox` | Opening doors, horn, lights and HomeLink can have real-world consequences. `remote_boombox` transport is unavailable by default. |
| Security and driving restrictions | `clear_pin_to_drive_admin`, `reset_pin_to_drive_pin`, `reset_valet_pin`, `parental_controls_activate`, `parental_controls_clear_pin_admin`, `parental_controls_deactivate`, `parental_controls_enable_setting`, `parental_controls_set_speed_limit`, `set_pin_to_drive`, `set_valet_mode`, `speed_limit_activate`, `speed_limit_deactivate`, `speed_limit_clear_pin`, `speed_limit_clear_pin_admin`, `erase_user_data`, `set_sentry_mode`, `guest_mode`, `remote_start_drive`, `speed_limit_set_limit` | Sensitive operations. Review the effective command policy and the user's explicit request; never infer support. |
| Navigation | `navigation_request`, `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request` | **Single-destination** `navigation_request` has a software path; the other three are experimental/disabled by default. |
| Vehicle and software | `sun_roof_control`, `upcoming_calendar_entries`, `set_low_power_mode`, `keep_accessory_power_mode`, `wake_up`, `set_vehicle_name`, `schedule_software_update`, `cancel_software_update` | `sun_roof_control` and `upcoming_calendar_entries` are unavailable by default; `wake_up` must not run implicitly. |
| Media | `media_toggle_playback`, `media_next_track`, `media_prev_track`, `adjust_volume`, `media_volume_up`, `media_volume_down`, `media_next_fav`, `media_prev_fav` | Depends on Tesla hardware/software and permissions. |

**Unavailable by default in the pinned proxy:** `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request`, `sun_roof_control`, `upcoming_calendar_entries`, `remote_boombox`, `remote_auto_steering_wheel_heat_climate_request`, `remote_steering_wheel_heat_level_request`. Certain navigation modes have **separately gated experimental paths**; the default exclusion must not be misrepresented as an absolute impossibility or a verified success.

## 6. What is and is not verified for navigation

| Scenario | Code state | Vehicle evidence |
| --- | --- | --- |
| Resolve a destination from OSM/Photon | Implemented software lookup | Address/entrance still requires user verification |
| Prepare an ordinary single-destination `navigation_request` | Implemented command path | Fleet API acceptance and display behavior depend on a live validated vehicle |
| Identify a public charging POI and prepare navigation to its **verified address** | Possible via ordinary navigation | **Does not** establish Tesla-native Supercharger classification or automatic battery preconditioning |
| Resolve 2–16 named places to Google Places IDs | Optional Google production path | Place IDs are not Tesla charging-station IDs; **no route is sent** by resolution alone |
| Prepare a 2–16 native `refId` waypoint payload | Experimental gate, verified local IDs required | **Not proven to display an ordered multi-stop route** |
| Experimental signed GPS Replace/Append | Diagnostic/experimental gates and journaling in source | API acceptance **does not** establish all destinations on the display; non-atomic and may be partial |
| Automatically send individual stops as a fallback for a whole itinerary | **Intentionally blocked** | Would replace destinations rather than faithfully preserve a full route |

## 7. Privacy and isolation

- Tools are exposed only when `TESLA_READ_ENABLED`, `TESLA_LOCATION_ENABLED`, `TESLA_COMMANDS_ENABLED` and `TESLA_COMMAND_EXECUTION_ENABLED` satisfy the relevant gate. Client scopes such as `battery:read`, `location:read` and `vehicle:control` are checked separately.
- The repository is designed for one configured OAuth subject per deployment and is **not** a multi-tenant public SaaS service.
- A 31-day app-collected reading history is not always-updated telemetry. No automatic `wake_up` is performed during cached reads.
- Public geocoding and routing disclose the locations/queries necessary to those providers **when consent is given**. Hosted AI clients and infrastructure providers maintain their own data policies.
- Real vehicle data, token store contents and registration values are environment-specific and must never be included in a public repository.

## 8. Performance, costs and verification

- No published end-to-end latency SLA, financial-savings benchmark, universal hardware list or live multipoint success rate is supported by this repository.
- Tesla Fleet API is usage-metered. A successful local calculation generally does not require a Tesla API call, while on-demand live reads, commands and some setup checks may consume quota.
- Redis, OAuth, hosting, Google Places and public-map usage may add direct costs or usage-policy restrictions.
- Automated offline tests use controlled fixtures. The developer separately reports online testing on their real Tesla; all 75 operations are reported as tested successfully, without an independently audited record or documented exact revision. Each deployment requires its own live validation.

Related documents: [Installation](GETTING_STARTED.md) · [Client support](CLIENT_COMPATIBILITY.md) · [Architecture](ARCHITECTURE.md) · [Release checklist](PUBLICATION_CHECKLIST.md).

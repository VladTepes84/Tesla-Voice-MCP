# Complete MCP tool reference

## Find a tool by intent

The **same tool names and schemas** are exposed to any suitably authorized AI client, independent of the AI brand. Whether a given client can call the tool is **conditional** on supported remote MCP transport, OAuth, the client workspace's tool permissions and current server gates. For **ChatGPT/Claude/Gemini/Grok** see [AI clients](AI_CLIENTS.md). For `resolve_waypoint_places` JSON arguments and Google Place IDs, see [Google Places setup](GOOGLE_PLACES_SETUP.md).



| You want to... | Start with | Why |
| --- | --- | --- |
| Check authorization safely | `get_connection_status` | No Tesla request or wake |
| Read an existing battery snapshot | `get_battery` | Timestamped cache, not a fresh read |
| Explicitly refresh the car | `get_live_vehicle_data` | On-demand, potentially metered |
| Estimate travel energy | `estimate_trip_energy` | Local, assumption-based math |
| Plan a charging corridor | `plan_charging_road_trip` | Bounded DC/HPC CCS2 search |
| Resolve a destination | `search_trip_destination` | Explicit map consent and ambiguity handling |
| Prepare an ordered itinerary | `plan_smart_trip` | Navigation-only 2–16; preparation is not dispatch |
| See potential vehicle actions | `get_vehicle_command_catalog` | Catalog visibility is not authorization to execute |
| Inspect a previous command | `get_vehicle_command_status` | Journal receipt; no blind repeat |

**Two different counts:** **38 MCP tools** are callable interface entry points; **75 operation names** are command definitions processed through specific command tools. The 75 operations are not 75 separate MCP servers, independent chat skills or guaranteed in-car functions. See [Why MCP](WHY_MCP.md) and [Evidence](EVIDENCE.md).


**Source of truth:** `simulator/lib/real-mcp.mjs`, its imported tool modules, `simulator/lib/mcp-tool-auth.mjs`, `simulator/lib/operation-plans.mjs` and [FEATURES.md](FEATURES.md). The catalog is **conditional**: a tool can be absent or denied because of deployment flags, scopes or missing provider setup. A tool definition does not guarantee an operational Tesla command.

This document inventories **38 named MCP tools** from the source-backed feature catalog, plus the separate **75-operation vehicle command catalog**. Do not confuse 38 MCP entry points with 75 command operations.

## Source-verified input examples

The following objects use argument names and constraints from the current source. They are **illustrative tool-call arguments**, not live provider responses, CLI commands or Tesla interactions. A compatible MCP client supplies these as a tool's arguments after authentication; do **not** paste them as raw text into the `/mcp` URL.

### A. Pure calculation — `estimate_trip_energy`

```json
{
  "distanceKm": 200,
  "consumptionKwhPer100Km": 16,
  "usableCapacityKwh": 60,
  "batteryPercent": 80,
  "reservePercent": 15
}
```

All five keys are required. Their units are **km, kWh/100 km, kWh and percentages**, respectively. This example calculates approximately **26.7% arrival SOC**. It reads no Tesla data, uses no map provider and sends no vehicle command. Source: `simulator/lib/energy-estimate.mjs`.

### B. Compare supplied tariffs — `compare_charging_costs`

```json
{
  "energyToBatteryKwh": 30,
  "efficiencyPercent": 90,
  "first": {
    "label": "Example A",
    "eurPerKwh": 0.40,
    "fixedFeeEur": 0
  },
  "second": {
    "label": "Example B",
    "eurPerKwh": 0.32,
    "fixedFeeEur": 3
  }
}
```

All four top-level keys are required. Each tariff needs `label`, `eurPerKwh` and `fixedFeeEur`; `powerKw` is optional. At 90% efficiency, the purchased energy would be about 33.33 kWh, giving illustrative costs of **€13.33 and €13.67**. These are **fictional** tariffs, not real network offers. Source: `simulator/lib/charge-cost-comparison.mjs`.

### C. Prepare an ordered itinerary — `plan_smart_trip`

```json
{
  "navigationOnly": true,
  "stops": ["Example Park", "Example Museum"],
  "destination": "Example Library",
  "externalMapsConsent": true
}
```

This schema demonstrates **three ordered destinations**: each element of `stops` followed by `destination`. The navigation-only schema allows at most **15 stops plus the final destination**, totaling **16**. The names above are deliberately fictional; do not expect a public geocoder to find them. Geocoding requires user consent and may return an ambiguity response. The tool prepares/stores a plan and **does not send it to Tesla**. Source: `simulator/lib/smart-trip.mjs`.

### D. Read-only tools with no arguments

`get_battery`, `get_connection_status`, `get_vehicle_status` and `get_vehicle_command_catalog` use an empty input object, for example:

```json
{}
```

Their behavior is **not identical**: connection/catalog checks use stored state; battery/status reads use Tesla cache. Never infer that a no-argument tool is automatically free of provider costs without checking its individual definition.

**Where to find every other exact schema:** read the tool's `inputSchema` from the authenticated MCP `tools/list` response, or inspect the named source module in [Architecture](ARCHITECTURE.md). The live schema is authoritative for the deployed commit.

## 1. Reading the reference

- **Cached:** local stored Tesla snapshot; does not itself wake or contact the vehicle.
- **Live:** can contact Tesla and consume a request budget; may be unavailable while the vehicle sleeps.
- **Local:** computation, stored preference or catalog lookup; may still access private Redis.
- **External:** calls a mapping, routing, charging-data or Tesla provider; review consent and quota.
- **Write:** changes server-side settings or may change a vehicle; needs user intent and additional guards.
- **Experimental:** implementation or transport path exists but live compatibility is not certified.

The MCP scopes enforced in `mcp-tool-auth.mjs` are `tesla:connect`, `battery:read`, `location:read`, `vehicle:control`. **`plan_smart_trip` and `get_planned_trip` require both battery and location permissions** under the special authorization response. Check the tool's actual `inputSchema` from `tools/list` for the exact argument shape and defaults; this reference deliberately does not invent parameter schemas that may change.

## 2. Authentication, connection and permissions (4)

| Tool | Scope | Effect | What to expect |
| --- | --- | --- | --- |
| `connect_tesla` | `tesla:connect` | Tesla OAuth linking | Explicitly initiated linking; not a token export |
| `get_connection_status` | `battery:read` | Local | Link state, scopes, gates and request budget; no vehicle contact |
| `prepare_vehicle_command_setup` | `tesla:connect` | Setup assistance | Virtual-key and partner prerequisites; not an implicit registration |
| `get_vehicle_command_catalog` | `battery:read` | Local | Operation names, parameter schemas, scopes and current dispatch availability |

**Example prompts:** “Is the connection ready without waking the car?” “List permitted commands without executing any.”

## 3. Vehicle readings, charging and connectivity (8)

| Tool | Scope | Effect | Important qualification |
| --- | --- | --- | --- |
| `get_battery` | `battery:read` | Cached | Includes timestamp; may be stale |
| `get_vehicle_status` | `battery:read` | Cached | Climate, locks, Sentry, odometer and software fields when available |
| `get_live_vehicle_data` | `battery:read` | Live | Single on-demand read; may contact/wake; no silent fallback or retry |
| `get_vehicle_reading_history` | `battery:read` | Local | App-collected samples for up to 31 days, not full Tesla telemetry |
| `get_vehicle_connectivity` | `battery:read` | Live | Online/asleep/offline as reported; no implicit wake |
| `get_vehicle_mobile_access` | `battery:read` | Live | Reads mobile-access state; does not modify it |
| `get_charging_history` | `battery:read` | Live/history | Recent returned sessions; not a universal invoice |
| `get_vehicle_schedules` | `battery:read` | Live | Reads charge/preconditioning schedules; does not edit them |

**Example prompts:** “Read the last cached battery sample.” “Explicitly refresh vehicle status once.” “Show my application's recorded readings.”

## 4. Location, place resolution and private aliases (10)

| Tool | Scope | Effect | Important qualification |
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

**Example prompts:** “Search for a destination and ask me to choose if ambiguous.” “Prepare verified waypoint IDs, but do not send them.”

## 5. Energy, routing, charging data and preferences (10)

| Tool | Scope | Effect | Important qualification |
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

**Example prompts:** “Calculate a route with a 15% reserve.” “Find CCS2 DC chargers; report unknown prices as unknown.” “Save my explicitly confirmed battery assumptions.”

## 6. Vehicle command execution and diagnostics (6)

| Tool | Scope | Effect | Important qualification |
| --- | --- | --- | --- |
| `prepare_vehicle_command` | `vehicle:control` | Staging | Validates and stages one command; does **not** dispatch |
| `execute_vehicle_command` | `vehicle:control` | Vehicle write | Executes a staged command after required confirmation |
| `execute_requested_vehicle_command` | `vehicle:control` | Vehicle write | Guarded explicitly requested direct action; no implicit user consent |
| `get_vehicle_command_status` | `vehicle:control` | Local receipt | Server journal/receipt; not proof of physical actuation |
| `start_gps_navigation_diagnostic` | `vehicle:control` | Experimental write | Explicit GPS phase A / Replace; display inspection required |
| `append_gps_navigation_diagnostic` | `vehicle:control` | Experimental write | Explicit GPS phase B / Append after separate observation |

**Example prompts:** “Prepare a command but do not execute it.” “Inspect the status of the command reference; do not retry.”

## 7. The 75 vehicle operations are **not** 75 independent MCP tools

The command catalog is defined in `simulator/lib/operation-plans.mjs`; its authoritative current names and argument schemas are exposed by `get_vehicle_command_catalog`. Operation groups include:

| Group | Examples (not an exhaustive list) | Boundary |
| --- | --- | --- |
| Charging | `charge_start`, `charge_stop`, `set_charge_limit`, `set_charging_amps`, `set_scheduled_charging` | Can change charging behavior |
| Climate | `auto_conditioning_start`, `set_temps`, `remote_seat_heater_request` | Hardware and firmware dependent |
| Access | `door_lock`, `door_unlock`, `actuate_trunk`, `flash_lights`, `honk_horn` | Real physical consequences |
| Security | `set_sentry_mode`, `set_valet_mode`, `set_pin_to_drive`, `remote_start_drive` | Sensitive controls; special care |
| Navigation | `navigation_request`, `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request` | Single destination available in code; other paths experimental/disabled by default |
| Vehicle/software | `wake_up`, `set_vehicle_name`, `schedule_software_update` | Never invoke implicitly |
| Media | `media_toggle_playback`, `media_next_track`, `adjust_volume` | Vehicle-specific support |

The baseline catalog contains **75 operation names**; **eight SDK transports are unavailable by default** in the pinned proxy: `navigation_gps_request`, `navigation_sc_request`, `navigation_waypoints_request`, `sun_roof_control`, `upcoming_calendar_entries`, `remote_boombox`, `remote_auto_steering_wheel_heat_climate_request`, `remote_steering_wheel_heat_level_request`. Some navigation transports have separately gated experimental paths. This is a code inventory, **not** a claim that 67 actions work on every Tesla.

For the **complete operation-by-operation inventory**, consult [FEATURES.md, section 5](FEATURES.md#5-remote-tesla-commands) and the live catalog returned by `get_vehicle_command_catalog`.

## 8. How to inspect exact argument schemas

The MCP `tools/list` result contains each available tool's `name`, `description`, `inputSchema` and authorization metadata. Use it as the contract for your **deployed version**, not a fabricated example JSON object.

```text
1. Authenticate a compatible MCP client to your /mcp endpoint.
2. Discover tools/list using the client's supported MCP transport.
3. Select a tool; inspect inputSchema.required and properties.
4. Check required OAuth scope and server-side feature gates.
5. Invoke tools/call only for the user-authorized operation.
6. Inspect isError, returned timestamps, provenance and receipt status.
7. If a vehicle write is uncertain, verify independently; do not retry blindly.
```

**Argument guardrails:** navigation-only planner accepts **2–16 ordered destinations**; energy-routing planner retains **8 intermediate stops**. Google Places resolution accepts 2–16 named destinations when explicitly enabled. Maps and station lookups have bounded limits. Do not assume a client can override these constraints.

## 9. Failure and permission semantics

| Failure class | Meaning | Safe response |
| --- | --- | --- |
| `mcp_authorization_required` | Missing MCP scope | Reauthorize with the specific scope; never reuse Tesla OAuth as MCP auth |
| Invalid arguments | Schema/validation failure | Correct input; no vehicle command should be inferred |
| Feature disabled | Gate or provider prerequisites missing | Explain required configuration; do not enable gates automatically |
| Consent required | External map/provider lookup not yet authorized | Ask for consent before sharing location/query |
| Provider quota/error | External source unavailable or budget exhausted | Show unknown/unavailable; do not invent data |
| Tesla unavailable | Vehicle asleep/offline or Fleet API issue | Report result; no automatic wake or retry |
| Command outcome uncertain | Receipt or acceptance lacks physical confirmation | Inspect receipt and vehicle state; do not duplicate |

Related: [Demo](DEMO.md) · [Installation](INSTALLATION.md) · [Customization](CUSTOMIZATION.md) · [Security model](SECURITY_MODEL.md).

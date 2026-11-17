# Customization and extension guide

## Customization principles

Prefer configuration and supported preference tools over code forks. Customize **the operator's private instance**, not tracked examples. This project does not import a user's Tesla favorites automatically, store a universal personal tariff contract or guarantee charger data freshness.

**Suggested order:** verify read-only connectivity → configure explicit energy assumptions → allow map queries with consent → save private aliases → enable optional Google Places only if necessary → review separate command permissions. No map or pricing preference is permission to operate the car.

For the purpose of this guide, **customization** means changing documented inputs, provider choices or local preferences, **not** extending the Tesla Fleet API or bypassing feature gates. See [Practical workflows](WORKFLOWS.md) and [Operator runbook](OPERATOR_RUNBOOK.md).


Every operator should customize a **private deployment**, not the tracked example data. This project is designed around one authorized subject per isolated instance; it is not a shared multi-tenant SaaS.

## 1. Start with configuration, not source-code edits

| Goal | Supported mechanism | What must remain private |
| --- | --- | --- |
| Host your own server | `APP_ORIGIN`, deployment and OAuth settings | Provider secrets, authorized subject |
| Choose region | `TESLA_FLEET_REGION` | Vehicle identifier and app credentials |
| Restrict requests | `TESLA_DAILY_READ_LIMIT`, provider-side budgets | Provider account details |
| Allow read-only use | Read gates and `battery:read` | Tesla tokens |
| Enable location tools | Location gate and `location:read` | Live position and private places |
| Enable vehicle control | Explicit command gates, `vehicle:control`, pairing | Signing private key and command authorization |
| Use public map search | OSM/Photon with explicit consent | Private Home/Work values |
| Enable Google Places | `GOOGLE_PLACES_SEARCH_ENABLED`, own key and quotas | Google API key, Place ID catalog |
| Configure recurring destinations | `FREQUENT_DESTINATIONS_JSON` or private saved-place tools | Addresses, coordinates, verified Place IDs |
| Set energy assumptions | `set_charging_preferences` after explicit user confirmation | Operator-specific capacity and efficiency values |

Never put real values in `simulator/.env.example`, `simulator/config/frequent-destinations.json`, tests, issue descriptions or screenshots.

## 2. Private frequent destinations

**Do you need to find or save a Google Place ID?** Start with [Google Places setup](GOOGLE_PLACES_SETUP.md). The project can use OSM/Photon/Nominatim/OSRM **without** purchasing Google Places; see [Maps and providers](MAP_PROVIDERS.md).

**Important:** A Google Place ID is not Tesla's native Supercharger identity; it does not guarantee battery preconditioning or on-screen waypoint acceptance.

The tracked catalog is deliberately empty. For a private verified native-waypoint catalog, set `FREQUENT_DESTINATIONS_JSON` in the deployment's private environment.

**Illustrative structure only** (fictional IDs and locations; not valid Tesla navigation references):

```json
[
  {
    "name": "Example Library",
    "aliases": ["library", "reading room"],
    "placeId": "EXAMPLE_NOT_A_REAL_PLACE_ID",
    "placeIdVerified": true,
    "placeIdSource": "https://example.org/example-verification"
  }
]
```

A production entry must use a **real independently verified** Place ID and valid provenance. Do not mark a fabricated ID as verified. Some flows also support `get_saved_trip_places` / `set_saved_trip_place` for private Home/Work aliases. These are **not** automatically imported from Tesla favorites.

## 3. Maps: OSM first, Google optional

- **Photon / OpenStreetMap** and bounded Nominatim fallback are supported for named places, with explicit consent.
- **OSRM** supplies road-routing estimates. Public service availability, limits and coverage vary.
- **Google Places API (New)** is an optional, operator-managed integration with a separate key, enablement gate, quota and potential billing. The project must not force Google billing for basic OSM discovery.
- Ambiguous results require a user selection; do not silently substitute the nearest name.
- Public geocoders may receive queries and locations. Avoid sending private Home/Work aliases to external services without explicit consent.
- A Google Place ID is not the same as a Tesla-native Supercharger ID.

## 4. Configure energy planning conservatively

Use `get_charging_preferences` to inspect existing assumptions and `set_charging_preferences` to update them only when the operator confirms values. Relevant concepts include:
- usable battery capacity (kWh);
- energy consumption (Wh/km or equivalent);
- minimum arrival reserve (%);
- maximum charge target (%);
- charging efficiency/loss assumptions;
- map-provider consent.

**Illustrative calculation** (not a Tesla measurement): 60 kWh usable, 160 Wh/km, 200 km route, departure 80%, reserve 15%:

```text
Estimated drive energy = 200 km × 0.160 kWh/km = 32.0 kWh
Estimated departure energy = 60 kWh × 0.80 = 48.0 kWh
Estimated arrival energy = 48.0 − 32.0 = 16.0 kWh
Estimated arrival SOC = 16 / 60 × 100 = 26.7%
Estimated margin above 15% reserve = 11.7 percentage points
```

The estimate excludes many real-world effects (speed, wind, temperature, gradient, HVAC, traffic, degradation, charging curve). Do not present it as an actual BMS reading.

## 5. Charging station data and tariffs

The source includes adapters for OSM and selected European public charging datasets. Availability, terms, attribution, completeness and commercial reuse restrictions differ by provider.

`find_charging_sites` supports local AC/DC/CCS2 discovery. `plan_charging_road_trip` is a **DC/HPC CCS2 corridor optimizer**; do not automatically insert AC sites into a long-distance fast-charging plan.

`compare_charging_costs` compares **caller-provided** variable and fixed fees. `get_free_to_x_card_tariffs` attempts to read a public direct-card/POS price list, not a personal subscription. Never apply one operator's personal discount to unrelated networks.

## 6. Navigation-only 2–16 vs energy route limits

| Mode | Limits | Action |
| --- | --- | --- |
| Navigation-only `plan_smart_trip` | **2–16 ordered destinations** | Resolve/prepare/save; no automatic vehicle dispatch |
| Energy-planning `plan_smart_trip` | **Maximum 8 intermediate stops** | Calculate route/energy/charging assumptions |
| Optional Google waypoint resolution | **2–16 names** | Resolve and disambiguate; no Tesla dispatch |
| Native/GPS transport | Additional feature and command gates | Experimental; independent display check required |

For an explicit itinerary, preserve **all stops and their order**. Do not use repeated single-stop navigation requests as a fallback. “API accepted” and “all stops displayed” are separate states.

## 7. Permissions and feature gates

Use the least-privileged MCP scope and Tesla Fleet scopes needed. `battery:read` does not authorize location or vehicle control. The server additionally checks its runtime gates, command allowlist and pairing prerequisites.

**Recommended operating progression:** offline → private read-only → map planning → explicit single action → experimental navigation, with independent acceptance checks between stages.

## 8. Extending the source safely

1. Read `AGENTS.md`, the module you intend to change, its tests and the relevant `operation-plans.mjs` or tool definition.
2. Add a narrowly scoped tool with a documented `inputSchema`, scope, feature gate and safe failure behavior.
3. Keep map resolution, calculation and vehicle command dispatch as separate layers.
4. Do not weaken authentication, allowlists, confirmation or no-retry protections.
5. Use synthetic fixtures; add boundary tests for 0, 1, maximum and maximum+1 inputs.
6. Run Node, Go, Redis-isolated tests and secret scanning.
7. Document costs, data sharing, live side effects and verification status.
8. Never claim a new command works on a vehicle until physically validated.

Related: [Tools](TOOLS_REFERENCE.md) · [Security](SECURITY_MODEL.md) · [Troubleshooting](TROUBLESHOOTING.md).

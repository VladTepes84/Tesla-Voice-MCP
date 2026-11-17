# Google Places API (New) and Place IDs — Beginner-to-operator setup

**Google Places is OPTIONAL.** Tesla Voice MCP already supports OpenStreetMap-based location search and road planning. Google Places (New) adds an **optional name-to-Place-ID resolver** for specific native-waypoint preparation workflows.

> **Safety boundary:** Finding a Google Place ID and preparing a `refId:` waypoint list **does not send a command to Tesla** and **does not prove Tesla will accept or display a multi-stop route**. All live navigation execution remains separately gated and experimental.

## What is a Google Place ID?

A **Place ID** is a unique identifier for a location in the Google Places database. It is **not** a coordinate pair, street address, Tesla charger identifier, guarantee of the correct building entrance or proof of compatibility with Tesla's navigation.

```text
Place name ("museum in a city")
   -> Google Places API (New): Text Search (optional, consented)
   -> possible candidates: name + address + Place ID
   -> user confirms the correct candidate
   -> MCP prepares refId:<verified-place-id>
   -> no vehicle dispatch
```

Google documentation: [Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id) and [Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search).

## Before you begin

- Your own Google Cloud account/project. Google Maps Platform requires billing configuration; requests may create fees.
- Your own **production** deployment of Tesla Voice MCP.
- A private hosting secret manager, isolated provider budget and quota alerts.
- An AI client authorized for the MCP `location:read` scope.
- Your explicit consent to disclose searched place names to Google.

**Do not enable Google merely because you use MCP.** It is not necessary for cached battery, local energy arithmetic or basic OSM-based routing.

## Step 1 — Create a Google Cloud project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project **controlled by you** or select your own existing project.
3. Set up the Google Maps Platform billing account and review current quotas and pricing. This can create actual usage charges.
4. Enable **Places API (New)** in the selected project. Do not assume that enabling the legacy Places API activates the New web service.
5. Set project-level budget alerts and appropriate API quotas before issuing real requests.

Follow Google's [official setup instructions](https://developers.google.com/maps/documentation/places/web-service/get-api-key) and [pricing documentation](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing). For an EEA billing account, review the current EEA-specific Google Maps Platform terms and data reuse restrictions.

**Expected result:** Your project has Places API (New) enabled and billing/quotas under your control. This alone does not enable this project's resolver.

## Step 2 — Create and protect a dedicated API key

1. In Google Cloud Console, open **APIs & Services → Credentials** and create a **new API key** solely for this server-side integration.
2. Under **API restrictions**, restrict it to **Places API (New)**.
3. Apply the strongest **application restrictions** compatible with your real server's network egress. For IP address restrictions, first verify whether your hosting environment provides stable egress IPs; do not assume Vercel has fixed outbound addresses.
4. Store the key only in private hosting environment/secret settings.
5. Set a quota appropriate to your expected searches and monitor usage for unexpected spikes.

**Never** put the actual key in `README.md`, `.env.example`, browser/client-side code, GitHub issues, screenshots or chat messages.

## Step 3 — Enable the code's production-only resolver

Set the following names in your **private hosting environment**, with values that belong to you:

| Name | Value/meaning |
| --- | --- |
| `GOOGLE_PLACES_API_KEY` | Your dedicated secret API key |
| `GOOGLE_PLACES_SEARCH_ENABLED` | `true` only when you want Google-based resolution |
| `TESLA_NATIVE_WAYPOINTS_ENABLED` | Must be enabled for the dedicated native-waypoint preparation path, after reviewing its experimental implications |
| `VERCEL_ENV` | **Must be `production`** in the code's Google resolver guard; supplied by the deployment platform, not a suggested local fake override |
| `APP_ORIGIN` | Exact HTTPS origin for your own server |

This code has an explicit protection that rejects Google resolver activation outside production mode or without a real dedicated key. **Never change code or fake the deployment environment just to bypass that restriction.**

**Important:** Google resolution and **Tesla dispatch** are separate. Enabling Google search does not activate signed navigation or grant `vehicle:control`. Tesla command execution has further OAuth, Fleet and feature gates. See [Configuration](CONFIGURATION.md) and [Security](SECURITY_MODEL.md).

## Step 4 — Find Place IDs through the MCP tool (preferred path)

The `resolve_waypoint_places` tool accepts **2–16 ordered named destinations**, each represented as an object containing a `query`. Example **tool arguments** using well-known public landmarks:

```json
{
  "externalMapsConsent": true,
  "stops": [
    { "query": "Eiffel Tower, Paris, France" },
    { "query": "Louvre Museum, Paris, France" }
  ]
}
```

- `externalMapsConsent: true` means the operator has explicitly agreed to send these names to Google.
- `stops` has **minimum 2, maximum 16** items; each `query` is 2–200 characters.
- This is **not** a command-line shell command and should not be pasted into the Tesla app. Your authorized AI client supplies these arguments in an MCP `tools/call`.
- The resolver sends a **Text Search (New)** request to `https://places.googleapis.com/v1/places:searchText`, using the field mask `places.id,places.displayName,places.formattedAddress,nextPageToken`.
- Each response can include up to **five candidates per query**. More candidates or an unclear match requires user confirmation.
- There is **no Tesla GPS read** or vehicle dispatch in this tool.

**Expected first result:** per-stop candidates, names and formatted addresses, or a clear status such as `needs_place_selection`. Do not expect these examples to be free of provider charges or geocoding ambiguity.

## Step 5 — Resolve ambiguity using `selectedPlaceId`

If a stop returns multiple candidates, inspect the **name, city and formatted address**, select the right Google candidate, then call the same resolver again using the ID returned **for that exact query**.

```json
{
  "externalMapsConsent": true,
  "stops": [
    {
      "query": "Eiffel Tower, Paris, France",
      "selectedPlaceId": "SELECT_ID_RETURNED_BY_GOOGLE_FOR_THIS_QUERY"
    },
    {
      "query": "Louvre Museum, Paris, France",
      "selectedPlaceId": "SELECT_ID_RETURNED_BY_GOOGLE_FOR_THIS_QUERY"
    }
  ]
}
```

**The placeholder above is not a valid real Place ID**; replace it with an ID actually returned by the lookup. The server will not accept an ID as selected unless it matches a current candidate for the associated query. Do not fabricate, reuse blindly or combine IDs from unrelated places.

**Expected resolved result:** `status: "payload_ready"`, a `command_request` for `navigation_waypoints_request`, a comma-separated `refId:...` list, and **`sent_to_vehicle: false` / `dispatch_performed: false`**. The result also distinguishes source validation from real-world semantic identity; users must still check that the chosen candidate is the intended place.

## Step 6 — Find a Place ID manually, when necessary

Google also maintains an official [Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id#find-id) and [Place IDs reference](https://developers.google.com/maps/documentation/places/web-service/place-id).

Manual discovery can help the operator understand the candidate list, but **the safest MCP resolver path still checks IDs against the Google search result and its own private proof state**. A copied text string is not automatically accepted as a verified Tesla waypoint. Place IDs can become obsolete or change; Google's documentation recommends refreshing older saved IDs.

For explicit private **Home** or **Work** aliases, the resolver will **not** search the text “Home” or “Work” publicly. Use `set_saved_trip_place` with a user-confirmed place reference in the operator's private store; `get_saved_trip_places` shows what exists. If a required private Place ID is missing, expect `needs_saved_place`.

## Step 7 — Optional private frequent-destination catalog

If you need a **verified local catalog**, keep it in the private `FREQUENT_DESTINATIONS_JSON` deployment setting, **not** `simulator/config/frequent-destinations.json` (which intentionally remains empty in Git).

**Schema illustration, NOT a usable verified ID:**

```json
[
  {
    "name": "Sample Museum",
    "aliases": ["sample museum"],
    "placeId": "NOT_A_REAL_PLACE_ID",
    "placeIdVerified": false,
    "placeIdSource": "https://example.org/verification-not-available"
  }
]
```

The sample is deliberately **unverified**. In real use, only mark `placeIdVerified` as `true` after confirming a genuine matching Place ID and providing a legitimate HTTPS provenance URL. The parser checks data shape and provenance URL syntax; operators remain responsible for actual identity verification. Do not commit private destinations, identifiers or exact coordinates.

## Step 8 — Test without ever sending Tesla navigation

1. Confirm `resolve_waypoint_places` is visible and authorized only where intended.
2. Resolve two **public** destinations; make sure candidate names and addresses match.
3. Resolve an ambiguous name; verify that the tool asks for user selection rather than guessing.
4. Check that private Home/Work aliases are not sent to public map search.
5. Confirm `payload_ready` has `sent_to_vehicle: false`.
6. Do **not** call `execute_vehicle_command`, `execute_requested_vehicle_command` or an experimental native/GPS transport as part of map setup.

**Success means:** Google-backed destination resolution and a prepared waypoint payload. It **does not** mean the entire route appears on an in-car Tesla display.

## What can go wrong?

| Status or symptom | Meaning | Safe response |
| --- | --- | --- |
| `places_not_configured` | Production guard/key not active | Check deployment environment and key; don't bypass guards |
| `native_waypoints_disabled` | Feature gate for native-waypoint preparation is off | Check whether you actually need this experimental path |
| `needs_place_selection` | Multiple candidates or unclear match | Inspect addresses and select the correct result |
| `selection_invalid` | Selected ID was not returned for that query | Choose from the current candidate list |
| `needs_saved_place` | Home/Work private reference missing | Save privately after explicit operator confirmation |
| `destination_not_found` | No acceptable result from provider | Clarify query, city or street |
| `google_places_daily_limit` | Configured request quota reached | Stop; check provider budget and usage |
| `google_places_unavailable` | Provider, cache, validation or network problem | Inspect sanitized diagnostics; no blind fallback to billable loops |
| `invalid_map_arguments` | Tool JSON violates schema | Correct number/order/shape of stops |
| Google ID found but Tesla doesn't show route | Resolution is not Tesla navigation | Report experimental state; don't send repeated single destinations |

## Source and license references

- Implementation: `simulator/lib/google-waypoints.mjs`, `simulator/lib/frequent-waypoint-catalog.mjs`, `simulator/lib/saved-trip-places.mjs`
- [Official Google Places setup](https://developers.google.com/maps/documentation/places/web-service/get-api-key)
- [Official Google Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [Official Google Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id)
- [Usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)
- [Map providers and privacy](MAP_PROVIDERS.md)
- [Navigation-only workflow](WORKFLOWS.md)

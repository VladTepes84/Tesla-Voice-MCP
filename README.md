# Tesla Voice MCP

**Talk to your Tesla through an AI assistant — with your own MCP server, your own credentials, and explicit control over what can access or change the vehicle.**

Tesla Voice MCP is an experimental, open-source, **self-hosted Model Context Protocol (MCP) server** that connects compatible AI clients to selected Tesla Fleet API capabilities. It combines vehicle readings, permission-gated remote commands, trip and charging calculations, mapping providers, and a conversational interface supplied by the client.

> **Important:** This repository is source code, not a hosted Tesla service or a one-click ChatGPT plugin. Each user must deploy their own server and configure Tesla Fleet API, OAuth, secure storage, and a compatible MCP client. No vehicle, client plan, firmware, or model is guaranteed to support every feature. This is an independent community project and is **not affiliated with or endorsed by Tesla or OpenAI**.

**[Complete feature catalog](docs/FEATURES.md)** · **[Installation and onboarding](docs/GETTING_STARTED.md)** · **[AI client compatibility](docs/CLIENT_COMPATIBILITY.md)** · **[Architecture and privacy](docs/ARCHITECTURE.md)** · **[Security policy](SECURITY.md)** · **[Panoramica in italiano](docs/README.it.md)**

## Why use Tesla Voice MCP?

Tesla's official app is designed for direct interaction with the vehicle. This project offers a different layer: **ask questions and request authorized operations in natural language from an AI client**, combining data from the vehicle with calculations and external maps when permitted.

| Benefit | What this implementation adds | Important limitation |
| --- | --- | --- |
| Conversational interaction | The AI client can call typed MCP tools instead of requiring manual navigation across separate screens. | Voice input/output is provided by the **client**; this server has no standalone voice app or built-in speech engine. |
| Vehicle context | Cached and on-demand battery/status readings, connection status, selected history and schedules. | The data may be cached, incomplete, unavailable, or subject to Tesla request costs. |
| Trip and energy reasoning | Route distance, explicit battery/consumption assumptions, reserve checks, charging-site search and price comparison. | Estimates are not official Tesla navigation or real-time charger availability. |
| More deliberate command control | Separate read, location and control scopes; commands require enabled gates and user intent. | Code-level command support does **not** prove a given vehicle can execute an operation. |
| Operator-managed infrastructure | Your own hosting, Tesla application, OAuth issuer, encryption key and private store. | Self-hosting creates operational and security responsibilities; it does not eliminate third-party data access. |
| Open and extensible code | Inspect tool contracts, providers, tests and guardrails; adapt your own deployment. | Changes require maintenance and must comply with provider terms. |

**Examples of requests to a compatible assistant** (illustrative only; execution depends on the configured tools and permissions):

- “What is my battery level, and when was that reading collected?”
- “Check the latest vehicle state without waking it.”
- “Estimate whether a 230 km trip preserves a 15% battery reserve.”
- “Find CCS2 fast chargers near this route, marking unknown prices or availability as unknown.”
- “Compare two charging tariffs that I provide for this session.”
- “Prepare navigation to this verified destination.”
- “Show which vehicle commands this installation currently permits.”

## Feature overview

The server groups its tools according to **actual runtime gates**, not an implied guarantee that every feature is enabled everywhere.

| Area | Implemented software capabilities | Readiness |
| --- | --- | --- |
| Account connection | Tesla OAuth linking, connection/permission diagnostics, virtual-key setup assistance | **Implemented**, deployment and Tesla authorization required |
| Battery and status | Cached battery and vehicle state; on-demand live reads; connectivity; timestamps and recent collected readings | **Implemented**, Tesla availability/quotas apply |
| Charging and schedules | Charging-session history, charge/preconditioning schedule reads, nearby Tesla charging-site discovery | **Implemented**, dependent on scopes and returned fields |
| Maps and places | Destination lookup, reverse geocoding, ambiguity handling, consent gates, private Home/Work aliases | **Implemented**, external provider accuracy varies |
| Trip and energy planning | Energy/reserve calculator, road routing, charging-cost comparison, DC/HPC CCS2 itinerary planning | **Implemented estimates**, not guaranteed navigation feasibility |
| Public station data | Italian/French/German/Swiss data adapters and OSM candidates; official Free To X card-price lookup | **Provider-dependent**, partial coverage and licensing limits |
| Vehicle actions | Allowlisted command catalog, preparation/confirmation flow, explicitly requested signed execution, receipt checking | **Implemented transport paths**, require virtual key, feature gates and vehicle validation |
| Multi-stop navigation | Private waypoint aliases, optional Google Places resolution, native waypoint/GPS experimental paths | **EXPERIMENTAL — route shown in the vehicle NOT verified** |
| Security and deployment | OAuth-protected remote MCP, per-tool scopes, encrypted server-side token storage, request budget, CI test definitions | **Implemented controls**, not a security certification |

See [FEATURES.md](docs/FEATURES.md) for **every exposed MCP tool**, supported command families, activation requirements and known restrictions. Tool availability is dynamic; a disabled feature is not equivalent to a working integration.

## How it fits together

```text
AI client (text and optionally voice)
          │ compatible remote MCP + OAuth access token
          ▼
  Your HTTPS /mcp endpoint
          │ validates issuer, audience, subject, token and scopes
          ▼
  Tesla Voice MCP (Node.js + Go command proxy)
          ├── encrypted, private Redis REST store
          ├── Tesla Fleet API / vehicle commands (only when authorized)
          └── optional maps, routing and charging-data sources (with consent)
```

The **MCP access token and Tesla OAuth token are different credentials**. The architecture is designed for **one authorized operator per isolated instance**, not an open multi-user public service. The server does not publish the operator's credentials for reuse by others.

## Installation: what each user must supply

1. **Tesla access:** their own Tesla account and Fleet API application, plus any required enrollment, authorized scopes and virtual-key pairing.
2. **Infrastructure:** an HTTPS deployment (the supplied configuration targets Vercel with `simulator/` as the root), a separate OAuth provider for the MCP client, and a private Redis REST store.
3. **Secrets:** server-side Tesla credentials, subject, token-store credentials and a distinct encryption key; never commit them.
4. **Client:** a chat/AI application that actually supports remote MCP plus the required OAuth workflow and permitted tools. ChatGPT account/workspace support varies by plan.
5. **Optional providers:** Google Places API (New) with user-managed quotas/billing; public OSM and national charging sources have their own policies.

**Read the complete [getting-started guide](docs/GETTING_STARTED.md) before deployment.** The baseline setup is not simply “paste a Tesla key into ChatGPT.” The endpoint is `https://<your-hostname>/mcp`; a local-only server cannot be connected to all remote AI clients without a supported bridge/tunnel.

## Safety, privacy and costs

- **No default live commands:** command execution requires explicitly configured gates and an authorized user request. Some diagnostic steps require explicit user inspection of the vehicle display.
- **No implicit `wake_up` or automatic repeat on uncertain execution:** a successful tool response or Tesla API acknowledgment is **not** proof of vehicle actuation.
- **No credentials or personal address catalog in the published example:** `simulator/.env.example` contains variable names only and `simulator/config/frequent-destinations.json` is empty.
- **No free-service promise:** Tesla API calls, hosting, OAuth, Redis, map requests and third-party data can create costs. Apply quotas, budgets and provider alerts.
- **Not a replacement for safety-critical driving decisions:** estimated routes, range, arrival charge, power, charging availability and rates need independent verification.
- **Data privacy is conditional:** self-hosting gives the operator control of the server, but Tesla, the chosen AI client, OAuth and mapping providers process data according to their own policies. Location queries are consent-gated in this code.

**Never post a VIN, live GPS location, token, Tesla client secret, private key, personal charging agreement or home/work address in a public issue or commit.** See [SECURITY.md](SECURITY.md).

## Current limitations

- A working MCP request is not equivalent to a successful **in-car** command. Hardware, firmware, fleet region, vehicle state and permissions matter.
- **Multi-stop native navigation is experimental.** Preparing `refId` waypoints or accepting signed GPS requests does not prove a 2–4 (or larger) ordered itinerary appears on the display. Repeated single-destination commands are **not** an authorized fallback.
- Google Places is **optional**; it is not bundled, free, or required for basic OSM-based discovery. Google Place IDs and Tesla-native charging-station identifiers are not interchangeable.
- A mapped address does not certify the exact building entrance; charging-site presence does not certify an open compatible stall; a charger address is not proof of Tesla preconditioning.
- No automatic polling for historical vehicle reads. Historical app samples accumulate only when tools are called.
- No built-in native iPhone app, speech engine, standalone consumer dashboard, billing service, or ready-made hosted account for arbitrary users.

## Development and validation

Requires **Node.js 22+ and Go 1.23+**. The repository defines offline tests and a GitHub Actions workflow. From the repository root:

```sh
node simulator/prepare-artifact.mjs
node --test simulator/*.test.mjs
(cd simulator && go test ./... && go build ./... && go vet ./...)
```

The artifact preparation step writes only to ignored `simulator/dist` locally; it does **not** deploy. The Redis-backed integration tests need an isolated local test store and are also defined in `.github/workflows/tesla-multipoint-ci.yml`. **Do not aim tests at your real vehicle or production Redis.** Passing these tests does not establish live compatibility.

**Maintainer release gate:** check [PUBLICATION_CHECKLIST.md](docs/PUBLICATION_CHECKLIST.md) and run the full tests on the final commit before changing visibility. The repository's public-release readiness and real-world user onboarding must be verified separately.

## Licensing, contributions and attribution

The code is distributed under the [MIT License](LICENSE). Third-party packages, Tesla Fleet API, Google Places, hosting, public geocoders and charging datasets retain their own terms; OpenStreetMap data requires attribution and ODbL compliance. Some Swiss charging-station data has a non-commercial reuse restriction. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CONFIGURATION.md](docs/CONFIGURATION.md).

Contributions are welcome after publication; see [CONTRIBUTING.md](CONTRIBUTING.md). Review third-party terms before redistributing datasets or building a commercial service. This project provides no warranty, guaranteed savings, safety certification, or Tesla endorsement.

# Tesla Voice MCP

An experimental Model Context Protocol (MCP) server for selected Tesla Fleet API features, vehicle information, navigation, charging discovery, and trip planning. The repository provides configurable software; each operator supplies and manages their own accounts, infrastructure, provider settings, and secrets.

This project is an early, self-hosted preview. Compatibility depends on Tesla account permissions, vehicle and firmware support, the MCP client, hosting, and third-party services. Passing offline tests does not verify live Tesla, Google Places, or vehicle behavior. Review the security and provider requirements before deployment.

## Capabilities

- Tesla OAuth connection and gated vehicle reads, including battery, connectivity, location, charging history, and schedules where permitted.
- Vehicle command preparation and guarded command execution, subject to Tesla Fleet API enrollment, virtual key pairing, explicit feature gates, account scopes, and vehicle support.
- Navigation destination lookup and experimental multi-stop preparation paths.
- Road-trip planning, energy estimates, charging-site discovery, and public charging-price lookup where source data is available.
- Optional Google Places integration and an operator-configured private destination catalog.

Some navigation transports and charging data sources are experimental or region-limited. The server does not guarantee a route will appear on a vehicle display or that a charging site is compatible, available, or current. Personal charging tariff plans are not stored. Price comparisons, when used, take values supplied for that request.

## Configure your own instance

See [Configuration and setup](docs/CONFIGURATION.md) for the complete setup guide. In brief, each operator needs:

1. Their own Tesla Fleet API application and any required Tesla enrollment or vehicle key pairing.
2. An HTTPS deployment, a separate OAuth authorization service for MCP clients, and a private Redis-compatible token store.
3. Their own secret values configured in the hosting provider's private environment settings.
4. Optional Google Cloud Places API credentials and an operator-owned destination catalog.

The example environment file contains variable names only: [`simulator/.env.example`](simulator/.env.example). Never commit populated environment files, API keys, OAuth credentials, vehicle identifiers, or private locations.

## Local checks

Use Node.js 22 or later and Go 1.23 or later. From the repository root:

```sh
node simulator/prepare-artifact.mjs
node --test simulator/*.test.mjs
(cd simulator && go test ./...)
```

The preparation command regenerates `simulator/dist`. Integration tests under `simulator/integration` require a separately configured local test store. Tests use synthetic fixtures and do not contact Tesla or operate a vehicle.

## Project status and terms

The implementation is intended for self-hosting by a single configured MCP subject per instance; it is not a ready-made multi-user hosted service. Do not enable live commands until you have reviewed the code, verified your own deployment and security controls, and confirmed the current Tesla requirements.

The code is distributed under the [MIT License](LICENSE). Tesla, Google, hosting, routing, and map data are governed by their own terms. OpenStreetMap data requires attribution and compliance with the ODbL. Some station catalogs have additional reuse restrictions; see the setup guide and verify source terms for your intended use.

# Configuration and setup

## Configuration philosophy — start with least privilege

The source deliberately requires multiple distinct settings because a connected vehicle is a security-sensitive system. This is **not** a “paste one API key and go” integration. Leave command and experimental-navigation gates off until the dedicated tests and authorization checks have been performed.

| Configuration layer | Purpose | Failure or risk if misconfigured |
| --- | --- | --- |
| Origin and routing | Defines the remote MCP identity and callback host | OAuth audience/callback mismatch |
| MCP OAuth | Authenticates the AI client, subject and tool scopes | Unauthorized or unavailable tool calls |
| Tesla OAuth | Grants access to the operator's Tesla resources | Permission failure or linking to an unintended account |
| Private encrypted store | Maintains authorization and private preferences | Unreadable/lost data or sensitive disclosure |
| Read/location gates | Separates data categories and privacy | Unexpected live reads or location sharing |
| Command/experimental gates | Protects physical action and unproven transport | Unsafe action or misleading success claims |

**Deployment recipe:** [Installation](INSTALLATION.md). **Operational rollback and incident handling:** [Operator runbook](OPERATOR_RUNBOOK.md). **Required acceptance evidence:** [Evidence](EVIDENCE.md).


This guide describes how to configure a self-hosted Tesla Voice MCP instance. Every operator must create and manage their own accounts, application registrations, infrastructure, provider credentials, and private data. The repository does not include working credentials or provide a shared hosted service.

The implementation is experimental. Offline tests do not verify integration with a live Tesla account, vehicle, Google project, hosting provider, or MCP client. Review the code and third-party terms before enabling live features.

## 1. Prerequisites

- Node.js 22 or later and Go 1.23 or later for local checks and builds.
- An HTTPS hosting deployment that supports the included Node.js handlers and Go components. The included deployment configuration targets Vercel with `simulator` as the project root.
- Your own Tesla Fleet API application and Tesla account access appropriate to the features you intend to use. Start with the [Tesla Fleet API documentation](https://developer.tesla.com/docs/fleet-api) and confirm current regional and enrollment requirements.
- A separate OAuth authorization service for authenticating MCP clients. Its access tokens must be verifiable by this server using RS256 and public JWKS keys.
- A private Redis REST store compatible with the configured token storage client.
- Optional: your own Google Cloud project with Places API (New) enabled.

Tesla and third-party services may charge for API use. Configure provider-side budgets and usage alerts.

## 2. Review the environment variables

Start with [`simulator/.env.example`](../simulator/.env.example). It contains names only; set actual values in your hosting provider's private secret store.

### Public deployment and Tesla

- `APP_ORIGIN`: the canonical HTTPS origin for your deployment, with no trailing slash or path.
- `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET`: credentials for your own Tesla application.
- `TESLA_FLEET_REGION`: the region supported by your Tesla application. Basic reads currently recognize `eu` and `na`; some partner-registration and command paths have EU-specific gates in the code.
- `TESLA_VEHICLE_VIN`: the vehicle identifier authorized for this instance.
- `TESLA_PUBLIC_KEY_PEM_BASE64`: the base64-encoded public key served at `/.well-known/appspecific/com.tesla.3p.public-key.pem`.
- `TESLA_DAILY_READ_LIMIT`: the application-level daily read budget. This does not replace provider-side limits or billing controls.

Register the exact callback URL for your deployment with Tesla:

```text
https://<your-hostname>/oauth/tesla/callback
```

Follow Tesla's current steps for application setup, partner registration, and vehicle key pairing. Command support depends on these requirements and on the vehicle. The public key endpoint must expose only the public key; never commit or publish its private key.

### MCP client authentication

Tesla OAuth and MCP client authentication are separate systems. A Tesla access token does not authenticate an MCP client to this server.

Configure your OAuth provider and then set:

- `MCP_AUTH_ISSUER`: the exact HTTPS issuer URL.
- `MCP_AUTH_JWKS`: the provider's public JWKS JSON.
- `MCP_ALLOWED_SUBJECT`: the one authorized subject for this instance.

The MCP audience is `APP_ORIGIN` followed by `/mcp`. Configure the required scopes for the tools you enable, such as `tesla:connect`, `battery:read`, `location:read`, and `vehicle:control`. The server checks the issuer, audience, token signature and expiry, subject, and required scopes. This configuration is for one authorized subject per instance, not a multi-user service.

### Encrypted token storage

Set `TOKEN_STORE_REST_URL` and `TOKEN_STORE_REST_TOKEN` to your own private Redis REST store. Generate a unique 32-byte encryption key and set it as `TOKEN_ENCRYPTION_KEY_BASE64`:

```sh
openssl rand -base64 32
```

Store the result only in your hosting provider's secret manager and retain a secure recovery copy. Do not put it in source control, issues, screenshots, or logs. Changing the key without migrating existing encrypted records makes them unreadable.

### Feature gates

The following settings are intentionally empty in the example file. Set only the gates required for features you have reviewed and configured:

- `TESLA_BACKEND_ENABLED`
- `TESLA_REAL_RELEASE_APPROVED`
- `TESLA_READ_ENABLED`
- `TESLA_LOCATION_ENABLED`
- `TESLA_COMMANDS_ENABLED`
- `TESLA_COMMAND_EXECUTION_ENABLED`
- `TESLA_PARTNER_REGISTRATION_APPROVED`
- `SIMULATED_MCP_MODE`

Keep live command execution disabled until authentication, storage, signing, vehicle compatibility, and Tesla enrollment have been verified in your own environment. Experimental navigation modes have additional gates and are not guaranteed to work on a vehicle.

## 3. Deploy and connect Tesla

1. Create a deployment from this repository using `simulator` as the project root.
2. Add the environment variables in the hosting provider's private settings. Set `APP_ORIGIN` to the exact HTTPS origin assigned to your deployment.
3. Configure the Tesla application's callback URL as shown above and complete any Tesla enrollment and public-key pairing steps required for your region and features.
4. Configure the MCP OAuth provider with the audience `APP_ORIGIN/mcp`, the required scopes, and the authorized subject. Set its issuer and public JWKS values in the deployment.
5. Configure the private Redis REST store and encryption key.
6. Connect using the MCP endpoint `https://<your-hostname>/mcp` and your MCP OAuth provider. Use `connect_tesla` to authorize your own Tesla account when prompted.
7. Check `get_connection_status` before requesting vehicle data. Cached reads may be stale; live reads may use quota or contact or wake the vehicle. Availability depends on current Tesla permissions, vehicle state, and service behavior.

Never use another person's client credentials, tokens, vehicle identifier, private key, OAuth subject, or private destination catalog.

## 4. Optional Google Places setup

1. Create your own Google Cloud project and enable Places API (New).
2. Review Google billing, quotas, regional availability, and terms.
3. Create a dedicated server-side API key. Restrict it to the required API and, where available, to your hosting egress addresses.
4. Set `GOOGLE_PLACES_API_KEY` privately and set `GOOGLE_PLACES_SEARCH_ENABLED=true` only after authentication, storage, and request quotas are configured.
5. Native waypoint preparation also requires `TESLA_NATIVE_WAYPOINTS_ENABLED` and the applicable production, location, and command gates.

The integration asks for consent before sending destination text to Google. A prepared waypoint payload is not proof that Tesla accepted or displayed the route.

## 5. Configure private destinations

[`simulator/config/frequent-destinations.json`](../simulator/config/frequent-destinations.json) is an empty public example. Keep your own destinations in the private `FREQUENT_DESTINATIONS_JSON` environment setting instead of editing a tracked file.

Use a JSON array. Each entry needs a `name` and an `aliases` array. For a native waypoint, also provide a verified `placeId`, set `placeIdVerified` to `true`, and provide an HTTPS `placeIdSource`. Verify each Place ID independently and include only places you are authorized to use. Treat this catalog as private account data; do not commit it or share it in public logs.

## 6. Use the available tools

The MCP tool catalog and available operations depend on configuration and permissions. Depending on the enabled features, tools can report vehicle state and location, retrieve charging history, prepare or send permitted commands, plan trips, estimate energy use, search for charging sites, and prepare navigation destinations. Read each tool's current description and returned safety or availability information before relying on it.

Some map and charging results are incomplete or stale. OpenStreetMap coverage and connector tags do not prove live availability or vehicle compatibility. The Free To X lookup reports its public direct-card price list when it can interpret the source. Any one-request price comparison uses values supplied for that request and does not verify current provider prices or availability.

## 7. Run local checks

From the repository root:

```sh
node simulator/prepare-artifact.mjs
node --test simulator/*.test.mjs
(cd simulator && go test ./...)
```

`node simulator/prepare-artifact.mjs` regenerates `simulator/dist`. Node tests use mock responses and synthetic fixtures; they do not authorize Tesla, access a real vehicle, or verify a live provider configuration. Tests under `simulator/integration` require a separately configured local Redis-compatible test store.

## Data and third-party terms

The code is distributed under the repository's [MIT License](../LICENSE). Third-party APIs and datasets have separate terms. OpenStreetMap data requires attribution and compliance with the ODbL. The Swiss charging catalog currently carries a non-commercial reuse restriction; review its source terms and obtain any required permission before commercial use. Review the current Tesla, Google, routing-provider, and hosting terms for your own deployment.

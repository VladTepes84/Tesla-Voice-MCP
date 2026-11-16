# Getting started — own your instance

This project is **not a public Tesla account broker** and cannot operate directly from a downloaded ZIP. The implementation targets an **operator-managed remote MCP deployment**. A user who does not have server administration, OAuth setup and Tesla Fleet API authorization cannot complete the installation simply by pasting Tesla credentials into an AI conversation.

## Prerequisites

| Requirement | Why it matters | Notes |
| --- | --- | --- |
| Tesla account and authorized vehicle | Fleet API reads and commands must be scoped to that owner's vehicle. | Vehicle/firmware and regional restrictions apply. |
| Tesla developer/Fleet API app | Each operator must register their own application and callback. | Partner registration and virtual key may be required for commands. |
| Remote HTTPS hosting | Compatible AI clients call `https://<host>/mcp`. | `simulator/vercel.json` targets a Vercel project rooted at `simulator/`; hosting cost varies. |
| Separate MCP OAuth provider | Verifies that the **AI client** and user are authorized to call tools. | Signed RS256 access tokens, issuer, JWKS, scopes, audience and one allowed subject are required. |
| Redis REST store + encryption key | Stores encrypted Tesla authorization and private account records. | Use an isolated, restricted store for each instance. |
| Node.js 22+; Go 1.23+ | Local tests and Go command proxy build. | Node code mainly uses standard libraries; Go dependencies are pinned in `go.mod`/`go.sum`. |
| Compatible AI client | Supplies the chat/voice interface and MCP protocol support. | Not every plan supports every tool. See [CLIENT_COMPATIBILITY.md](CLIENT_COMPATIBILITY.md). |
| Optional Google Places API key | Resolves named native-waypoint candidates under a dedicated production gate. | Google billing, quotas and product terms apply; not needed for basic OSM searches. |

## Phase A — read the project before connecting a car

1. Review [FEATURES.md](FEATURES.md) and identify which tool categories you actually need. Start with **read-only** capabilities.
2. Read [SECURITY.md](../SECURITY.md), [ARCHITECTURE.md](ARCHITECTURE.md) and the relevant parts of [CONFIGURATION.md](CONFIGURATION.md).
3. Clone or download the **public source**. Do not copy anybody else's deployment, Tesla account, Redis database, OAuth tenant or environment values.
4. Open [`simulator/.env.example`](../simulator/.env.example). It intentionally supplies **names, not credentials**. Never fill a tracked `.env.example` or commit a live `.env`.

## Phase B — local/offline validation

From the source root:

```sh
node --version
go version
node simulator/prepare-artifact.mjs
node --test simulator/*.test.mjs
(cd simulator && go test ./... && go build ./... && go vet ./...)
```

The preparation command builds a **local** ignored `simulator/dist` artifact and is not a deployment. Most unit tests simulate providers and must not be advertised as live Tesla tests. The repository also defines Redis-backed integration tests in `.github/workflows/tesla-multipoint-ci.yml`; run those only with **isolated test Redis**. Check the final commit's GitHub Actions result. A green build does not prove commands work on your vehicle.

## Phase C — create the operator's own private infrastructure

1. Register a Tesla developer application and determine the region, scopes, approved enrollment and virtual-key requirements for your specific Tesla account/vehicle.
2. Create a private HTTPS deployment from this source, with `simulator/` as the root if using the provided Vercel configuration. Initially **disable live vehicle command execution**.
3. Create or select a dedicated MCP OAuth provider that issues **RS256 access tokens** and publishes its public JWKS. The token must include an exact issuer, audience (`APP_ORIGIN/mcp`), an allowed user subject and the scope needed by each tool.
4. Provision an isolated Redis REST-compatible store. Generate your own **32-byte encryption key** locally; store it and all credentials **only** in your hosting secret manager, with tightly scoped access and a secure recovery method. Never share its value in chat or public logs.
5. Set the environment variables described in [CONFIGURATION.md](CONFIGURATION.md): `APP_ORIGIN`, Tesla application credentials, OAuth issuer/JWKS/subject, store URL/token, encryption key and explicit feature gates. Do not reuse any names or secrets from the maintainer's private deployment.
6. Register the exact Tesla callback `https://<your-hostname>/oauth/tesla/callback`, and configure any Tesla virtual-key public endpoint and account pairing specified by Tesla. Do not publish the associated private signing key.
7. Restrict access to the deployment, enforce HTTPS, review billing/quotas and confirm that your OAuth provider grants only one approved subject to this instance.

**Do not enable** `TESLA_COMMANDS_ENABLED` / `TESLA_COMMAND_EXECUTION_ENABLED` simply to test the server. Begin with server health, OAuth boundaries, connectivity and cached reads. The required feature gates for production include `TESLA_BACKEND_ENABLED`, `TESLA_REAL_RELEASE_APPROVED`, and the corresponding read/location/control gates; see the current `CONFIGURATION.md` for all conditions.

## Phase D — attach an MCP-capable AI client

1. Verify that your AI client supports **remote MCP** and the server's OAuth arrangement. Some clients only support local `stdio`, read-only tools or organization-approved server connections.
2. Register **your server endpoint**, not a Tesla URL: `https://<your-hostname>/mcp`.
3. Complete the **MCP OAuth** authorization. The MCP access token authorizes the AI client and is separate from the Tesla account connection.
4. If needed, explicitly ask the assistant to run `connect_tesla`. Complete authorization on Tesla's own flow; the assistant should not request credentials pasted into chat.
5. Call `get_connection_status`, then read-only tools such as `get_battery`. Verify returned timestamps and whether results are cached or live.
6. Enable location separately only after you understand what data the client and public mapping providers will receive. For location-to-address requests, give the required external-map consent.
7. Enable signed vehicle control only after Tesla virtual-key pairing, the server's explicit action gates and a safe, observable live test are confirmed for your installation.

## Phase E — realistic acceptance checks

Before treating an installation as working, record evidence for these independent outcomes:

- [ ] MCP discovery lists only enabled tools with the scopes you intended.
- [ ] Tokens with wrong issuer, audience, subject, expired signature or missing scope are rejected.
- [ ] Account connection is **your own** Tesla account; no other operator's VIN, secrets or places are used.
- [ ] Cached battery/status readings return timestamp and do not silently claim to be live.
- [ ] An intentionally authorized live read succeeds and does not issue unrequested retries or `wake_up`.
- [ ] Planning tools return estimated results, sources and limits without sending commands.
- [ ] If vehicle controls are enabled, one explicitly requested command can be verified **on the actual vehicle** with an independently observed result.
- [ ] For native/multipoint navigation, **each stop is physically confirmed on the display in order**. An API acknowledgment alone fails this test.

## Common failure modes

| Symptom | Likely checkpoint |
| --- | --- |
| MCP server refuses authorization | Issuer/JWKS, RSA signature, audience `APP_ORIGIN/mcp`, subject equality, scope, expired token or HTTPS origin. |
| Tesla linking succeeds but vehicle reads fail | Tesla account permission, application/region/scopes, VIN authorization, disabled read gate, quota or unreachable vehicle. |
| Cached values look stale | The tool intentionally returns cached data; select a permitted live-read tool if a fresh reading is essential. |
| AI client can read but not control | Client plan/tool permissions, MCP `vehicle:control` scope, virtual-key pairing or server control gates. |
| No Google Places waypoints | Optional Google key/production feature gate/billing/consent, verified IDs and quota. |
| Multi-stop command accepted, route not on display | Experimental transport not proven for this firmware/vehicle; do **not** automatically repeat or substitute repeated single stops. |
| Charging-site search returns no results | National/open map coverage may be incomplete, timed out, stale or unavailable. |
| Unexpected provider charges | Disable unneeded live reads/maps, review provider metering, server budgets and request logs without exposing private data. |

## Support expectations

Open source distribution allows people to inspect and deploy the code; it **does not provide** a shared Tesla developer account, free Fleet API usage, a preauthorized Tesla vehicle, a universal assistant subscription, customer support SLA, or Tesla endorsement. Follow the provider documentation for the current prices and permissions.

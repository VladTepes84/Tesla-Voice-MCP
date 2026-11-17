# Connecting an AI client to Tesla Voice MCP

## Before you attempt the connection

**Only connect an instance you own and have configured.** Adding an MCP URL in an AI client does not automatically create a Tesla application, Redis store, OAuth issuer or signing key. Confirm your client supports remote MCP **and** this server's OAuth security model.

**Current ChatGPT integration note (reviewed 2026-11-17):** OpenAI documents custom MCP creation/connection through eligible web workspaces; full MCP support is subject to workspace permissions, while some plans have more limited read/fetch access. Adding or configuring a custom MCP connection is **web-only** in the documented workflow. Tool availability may be frozen until the supported refresh process. See [official guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt), and verify the UI and entitlements at setup time. Do not promise command execution for all users.

**First test:** authenticate MCP, inspect the discovered read-only tools, run `get_connection_status`, then read `get_battery` only if linked and cached data exists. Do not begin with vehicle control.


The server exposes a **remote, OAuth-protected MCP endpoint**. It is not a ChatGPT subscription feature, an App Store application, a standalone voice assistant or a local-only `stdio` server.

## Client compatibility requirements

The chosen client must support:
1. Remote MCP over HTTPS with the transport/protocol used by `/mcp`.
2. OAuth authorization to a custom resource, including the required JWT audience and scopes.
3. Tool discovery and tool calls, including permission prompts for side-effecting actions.
4. An operator-approved deployment and administrative permissions when required by the platform.

**Do not assume that every client, account plan or workspace supports custom MCP servers or vehicle-control tools.** Check the current provider documentation and actual client UI before onboarding.

## Generic remote MCP connection

```text
Server URL: https://<your-hostname>/mcp
Protected resource: https://<your-hostname>/.well-known/oauth-protected-resource
MCP OAuth issuer: your independently configured OAuth provider
OAuth resource/audience: https://<your-hostname>/mcp
Tesla OAuth: completed separately through connect_tesla
```

The angle-bracket placeholders are not literal addresses. Never paste Tesla client secrets, refresh tokens or Redis credentials into an AI client's chat or public connector description.

## ChatGPT (when the workspace supports custom MCP)

1. Complete [Installation](INSTALLATION.md) first; do not try to register the source repository as the server.
2. In the supported ChatGPT web workspace, find the current **Plugins / custom MCP** management interface; naming and eligibility may change.
3. Add your **own** HTTPS `/mcp` URL, not Tesla's Fleet API endpoint.
4. Complete the supported MCP OAuth connection and review requested permissions.
5. Check that `get_connection_status` and `get_vehicle_command_catalog` appear only when appropriate.
6. Link Tesla with `connect_tesla` if required. Begin with `get_battery`, not vehicle control.
7. For command tools, explicitly approve each requested action and independently verify the outcome.

Consult [OpenAI's current custom MCP guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) for account-specific availability. The project does not bypass ChatGPT's own client-side approvals.

## Other clients

Clients may support local `stdio`, remote Streamable HTTP, legacy SSE or different OAuth capabilities. A compatible protocol name alone does **not** guarantee that the OAuth flow or control tools work.

Before claiming support, verify:
- remote transport and auth discovery;
- issuer/JWKS, resource audience, scope upgrade and token refresh behavior;
- permission prompting for vehicle writes;
- handling of structured MCP errors and long-running requests;
- the distinction between an accepted command and an observed vehicle change.

If a client does not support the required remote OAuth flow, **do not** work around it by embedding Tesla tokens or disabling server authentication.

## Voice behavior

The client performs speech recognition and speech synthesis. The MCP server receives tool calls and returns structured results. Spoken intent should be interpreted conservatively: ambiguous locations, vehicle commands and irreversible actions need clarification/approval according to the active gates.

## First five safe prompts

1. “Check whether my MCP/Tesla connection is ready without contacting the vehicle.”
2. “Show the vehicle command catalog, but do not execute anything.”
3. “Read the cached battery level and state its timestamp.”
4. “Estimate a trip using values I provide; do not read or control the vehicle.”
5. “Explain which map permissions are needed before looking up an address.”

## Diagnosing a client connection

| Symptom | Check |
| --- | --- |
| Cannot add server | Client plan/workspace eligibility, HTTPS reachability and remote MCP support |
| OAuth loop | Exact `APP_ORIGIN`, resource audience, issuer, callback and subject |
| HTTP 401 | Signature, expiry, issuer, audience, allowed subject |
| Insufficient scope | The tool's required `battery:read`, `location:read`, `tesla:connect` or `vehicle:control` |
| Tool not listed | Server feature gate, caller permissions, deployment revision |
| Tool listed but rejected | Tesla account connection, Fleet scopes, virtual key, operation policy, quota |
| “Accepted” but no car change | Command receipt and independent vehicle verification; never blind retry |

Related: [Tool reference](TOOLS_REFERENCE.md) · [Troubleshooting](TROUBLESHOOTING.md).

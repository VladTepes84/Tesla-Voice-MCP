# Using Tesla Voice MCP with AI clients

## At-a-glance compatibility decision

| Question | Required answer before proceeding |
| --- | --- |
| Does the client support **remote HTTPS MCP**? | Yes; local-only `stdio` is insufficient without a supported bridge |
| Can it authorize this server's **MCP OAuth resource**? | Yes; Tesla OAuth credentials alone are not accepted |
| Can the operator or workspace add a custom server? | Confirm current plan and administrative permissions |
| Are **write-capable tools** allowed by this client? | Explicitly check; read/fetch-only modes cannot be assumed to execute vehicle commands |
| Does the server list the intended tools and scopes? | Verify current `tools/list`, with any client-side cache refreshed appropriately |

**Do not advertise generic “works with ChatGPT” as universal support.** The correct claim is **“integrates with compatible AI clients that support custom remote MCP, OAuth and the required tool permissions.”**


> Documented against product guidance available on 2026-11-16. Client capabilities, account entitlements, and setup screens may change. This document is **not** a compatibility attestation for every client.

## What this repository provides

This repository is source code for a **self-hosted, OAuth-protected, remote MCP server**. It is not a public hosted service, a plug-and-play ChatGPT app, or a credential-only installer. Do not use the original maintainer's deployment, token store, Tesla application, OAuth issuer or secrets.

Each independent operator needs:

1. A Tesla account with access to their own vehicle and an appropriately registered Tesla Fleet API application (including owner consent, permitted scopes, and any required partner registration / vehicle-key pairing).
2. A separate HTTPS deployment of `simulator` with a stable `APP_ORIGIN`, reachable at `https://<your-hostname>/mcp`.
3. A distinct MCP-client OAuth provider issuing RS256 access tokens with issuer `MCP_AUTH_ISSUER`, audience `<APP_ORIGIN>/mcp`, required per-tool scopes, and subject exactly equal to `MCP_ALLOWED_SUBJECT`. This is **separate** from Tesla OAuth.
4. A private Redis REST token store and a unique server-side encryption key. Keep all secrets, VINs, personal destinations, and OAuth credentials in private deployment settings, never in Git.
5. An AI client that actually supports remote MCP and the required OAuth flow. A download of this GitHub repository does not register a plugin with any chat platform.

Follow [Configuration and setup](CONFIGURATION.md), including the Tesla callback URL and production safety gates. The default example environment contains **no live credentials**. Google Places is optional; using it may require a billing-enabled Google project.

## ChatGPT

The current OpenAI help guidance states that **full custom MCP server connections** are supported for ChatGPT Business and Enterprise/Edu workspaces on web, subject to admin/owner or delegated developer permissions. The Pro developer-mode path has more limited read/fetch permissions. Other account plans and product rollouts must be checked in the current UI; do not assume that a ChatGPT subscription guarantees custom vehicle-command support.

If your account/workspace supports custom MCP servers:

1. Deploy and validate **your own** server, token store, OAuth provider, Tesla application, and authorized vehicle.
2. In ChatGPT, open **Plugins**, use **Add custom MCP server**, and enter the public HTTPS endpoint `https://<your-hostname>/mcp` (or a supported secure tunnel).
3. Configure the supported OAuth connection, review the security warning, and inspect the discovered tool list. The MCP OAuth token must be for this server; a Tesla token alone will not authenticate the client.
4. Authorize the Tesla account using the server's `connect_tesla` flow, then start with `get_connection_status` and read-only tools. Enable vehicle-control permissions and feature gates only if required and separately tested.
5. Independently verify any command reaches the intended vehicle; tool acceptance is not proof of vehicle actuation or navigation displayed on screen.

Current guidance: <https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt>.

## Other MCP clients and AI applications

Compatibility is conditional, **not universal**. The client must implement the required remote MCP transport, OAuth access tokens and approval model, and support the server's protocol/tool metadata. Some assistants support only local MCP servers, read-only tools, or administrator-approved integrations. Verify on a client-by-client basis, especially before enabling vehicle commands.

For developers using the OpenAI API, remote MCP is supported through the MCP tool/server URL integration, but this still requires an independently hosted server and authorization managed by the developer: <https://developers.openai.com/api/docs/guides/tools-connectors-mcp>.

## Security and operating costs

- Deploy one isolated, authorized operator per instance. The current code is not a multi-tenant service and must not be exposed as a shared instance with arbitrary users.
- Leave live commands disabled while validating OAuth, scopes, HTTPS, token storage, user intent, and vehicle pairing; do not implicitly wake the car or retry uncertain commands.
- Tesla Fleet API use is metered. Hosting, Redis, the OAuth provider, and optional mapping providers may also charge; configure budgets, quotas, and alerts.
- Native navigation and multi-stop commands are experimental; no general guarantee of compatibility across models, hardware, regions, firmware, or clients.
- Redis and OAuth security are necessary even if you intend to use the server only for your own car.

Project support is best-effort: the MIT license does not promise an operational service or a successfully completed Tesla command.

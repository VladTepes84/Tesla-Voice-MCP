# Getting started — choose the shortest safe path

This is a **condensed operator checklist**. It does not replace the full installation or beginner's guide. Tesla Voice MCP is a self-hosted remote MCP server, not an app you activate by pasting a vehicle token into chat.

## Which guide should you follow?

The goal is **not to install this source inside the AI**. Deploy your own remote HTTPS MCP server, then connect an eligible AI app to its `/mcp` endpoint. Your AI may accept typed requests and, **only when its voice mode supports MCP tools**, spoken requests.

For cross-platform connection instructions see [AI clients](AI_CLIENTS.md); for voice limitations see [Voice usage](VOICE_USAGE.md); for optional Google lookup see [Google Places setup](GOOGLE_PLACES_SETUP.md).



| Goal | Recommended document | First meaningful success |
| --- | --- | --- |
| See what the project does | [Guided demo](DEMO.md) + [Why MCP](WHY_MCP.md) | Understand capabilities and their limits |
| Try it without an account | **[Beginner's Guide](BEGINNERS_GUIDE.md)** | Zero-failure offline Node/Go checks |
| Deploy your own private server | **[Complete installation](INSTALLATION.md)** | Authenticated remote MCP discovery |
| Connect an AI client | [Client setup](CLIENT_SETUP.md) | Correct OAuth and intended read-only tools visible |
| Configure a Tesla account | [Configuration](CONFIGURATION.md) | Explicit Tesla linking and timestamped cached reading |
| Enable signed vehicle commands | [Operator runbook](OPERATOR_RUNBOOK.md) | Separately authorized and independently observed single action |
| Validate a multipoint itinerary | [Workflows](WORKFLOWS.md) | Ordered planner output; physical display still requires separate proof |

## The safe first commands

With Node.js 22+ and Go 1.23+ installed, from the repository root:

```sh
node simulator/prepare-artifact.mjs
node --test simulator/*.test.mjs
(cd simulator && go test ./... && go build ./... && go vet ./...)
```

These are **local tests with synthetic fixtures**, not Tesla login, live vehicle operations or deployment. The Redis integration suite needs an isolated test store; see `.github/workflows/tesla-multipoint-ci.yml`.

## Connected setup, in order

1. **Secure HTTPS deployment:** your own host, `simulator/` root for the included Vercel config, exact `APP_ORIGIN`.
2. **Private store:** isolated Redis REST and a unique private encryption key.
3. **Separate MCP OAuth:** RS256/JWKS, resource audience `<APP_ORIGIN>/mcp`, one allowed subject and least-privilege scopes.
4. **Tesla application:** your own Fleet API registration, Tesla OAuth callback, permissions, vehicle and regional requirements.
5. **Compatible AI client:** authorize to your own `/mcp` endpoint; verify discovery and denied invalid tokens.
6. **Tesla linking:** explicitly request `connect_tesla`; test `get_connection_status`, then `get_battery` if cached data exists.
7. **Optional expansion:** consented maps, calculations, then separately approved signed vehicle controls after a real-car test.

**Never enable all flags to bypass an error.** No credentials or vehicle IDs should appear in Git, chats, issues or diagnostic screenshots. Costs depend on Tesla, hosting, storage and optional providers.

## What success does—and does not—prove

- **Offline tests passed:** code paths and mocks, not a real car.
- **MCP OAuth worked:** client authenticated, not necessarily Tesla-linked.
- **Tesla OAuth worked:** account linked, not necessarily command-paired.
- **Tool result accepted:** request processed, not a physical change.
- **2–16 destinations prepared:** ordered plan produced; in-car route still experimental.

For details: [Installation](INSTALLATION.md) · [Evidence](EVIDENCE.md) · [Security](SECURITY_MODEL.md) · [Troubleshooting](TROUBLESHOOTING.md).

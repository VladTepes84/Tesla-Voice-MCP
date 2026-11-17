# Contributing

## Contribution quality bar

A contribution is valuable when it improves user outcomes **without exaggerating evidence**. Every proposed change should state the actual capability, the layers touched, exact tests run, privacy and cost implications, backward compatibility of tool schemas, and what still needs a real vehicle.

- Begin with [Architecture](docs/ARCHITECTURE.md), [Tool reference](docs/TOOLS_REFERENCE.md) and [Evidence](docs/EVIDENCE.md).
- For a new assistant workflow, add a **synthetic example** to [Practical workflows](docs/WORKFLOWS.md) and document its tool, inputs, scopes and failure modes.
- For changes affecting costs or map data, document the operator/provider terms and consent requirements.
- Keep testing and deployment separate: source changes never imply auto-registration, live commands or release approval.


Tesla Voice MCP is an experimental integration with vehicle data and commands. Changes affecting authorization, navigation, stored credentials or real vehicle actions must be reviewed especially carefully.

## Before proposing changes

- Read [SECURITY.md](SECURITY.md), [FEATURES.md](docs/FEATURES.md) and [CONFIGURATION.md](docs/CONFIGURATION.md).
- Do **not** open a public issue or PR containing credentials, personal locations, a VIN, JWTs, real access logs or samples copied from a private deployment.
- Prefer minimal, reversible changes in the appropriate module. Do not change API/tool names, authentication boundaries or execution gates without a clearly scoped compatibility and security review.
- Ensure any additional map, station or charging dataset allows your proposed redistribution, use and attribution. Do not include copyrighted or access-restricted provider data without permission.
- Add synthetic fixtures and focused tests when introducing or changing behavior.

## Offline validation

Node.js 22+ and Go 1.23+ are required:

```sh
node simulator/prepare-artifact.mjs
node --test simulator/*.test.mjs
(cd simulator && go test ./... && go build ./... && go vet ./...)
```

If Redis integration tests are needed, run them only against an isolated test store; refer to `.github/workflows/tesla-multipoint-ci.yml`. Never send live Tesla commands during routine CI or code review. A successful offline test does not prove the route appeared on the vehicle display.

## Report changes accurately

For each PR, describe: feature/bug, exact files changed, test commands actually run, observed outputs and remaining limitations. Distinguish a simulated case, an API accepted result and independently confirmed real-vehicle behavior. Never claim real-world vehicle compatibility solely from mock tests or SDK operation names.

Security concerns should be reported privately, not with exploit details posted in public issues.

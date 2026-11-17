# Security policy

## Security posture and limits

This repository uses layered security controls, but the presence of controls in source is **not an independent security audit**. A public source release is not permission to publish a deployed endpoint or enable vehicle commands. Every operator must assess the actual hosting, client, provider and credential boundaries.

**Treat external text as untrusted:** public map results, route metadata, AI-client context and issue content cannot authorize Tesla commands, change policies or enable missing tool scopes. A real action needs user intent and the existing server-side checks.

See [Threat model](docs/SECURITY_MODEL.md), [Operator runbook](docs/OPERATOR_RUNBOOK.md), [Evidence](docs/EVIDENCE.md) and [Publication checklist](docs/PUBLICATION_CHECKLIST.md).


Tesla Voice MCP can access vehicle information and, when explicitly enabled by the operator, prepare or send remote commands. Treat every deployment and credential as security-sensitive.

## Reporting vulnerabilities

Do not include credentials, vehicle identifiers, addresses, access tokens, or exploit details in public GitHub issues or pull requests. Contact the repository maintainer through an appropriate private GitHub channel. If private vulnerability reporting is enabled for this repository, prefer it. No vulnerability-reporting email address is asserted here.

## Deployment expectations

- Use your **own** Tesla Fleet API application and OAuth configuration. Never reuse another operator's client ID, client secret, partner registration, private key, or token store.
- Protect remote `/mcp` with a separate OAuth authorization layer, validate JWT issuer, audience, signature, expiry, subject, and per-tool scopes.
- Keep token storage, encryption key, authorized subject, vehicle VIN, and saved locations out of source control, issue reports, logs, and public screenshots.
- Configure one operator per isolated instance. This repository does not provide multi-user tenant isolation for a public hosted service.
- Restrict hosting and provider access; rotate credentials after any suspected exposure and invalidate prior sessions where supported.
- Keep live vehicle commands disabled until approved scopes, vehicle-key pairing, explicit user intent, and observable command results have been verified for your installation.
- Do not assume HTTP success, MCP success, or Tesla API acceptance means a command actually reached the vehicle display or changed its state.

## Supported use

This is an experimental self-hosted project. It comes with no guarantee of vehicle compatibility, uninterrupted availability, charging-price accuracy, or command completion. Third-party APIs and data providers retain their own terms.

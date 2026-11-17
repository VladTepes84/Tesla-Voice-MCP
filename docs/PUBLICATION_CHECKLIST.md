# Public release gate

This checklist is deliberately incomplete until the maintainer performs the indicated actions. Preparing a patch is **not** approval to change repository visibility.

## Source and history

- [ ] Confirm the target is the sanitized public-release candidate repository, not a private production repository or its deployment.
- [ ] Review all tracked files, reachable branches, tags, releases, workflow artifacts, PRs, and commit author metadata for secrets and personal information.
- [ ] Re-run a dedicated secret scanner against the working tree **and all reachable Git history**, then manually review suspicious fixtures and high-entropy strings. A regex scan alone is insufficient.
- [ ] Confirm with GitHub Support as appropriate that the accidentally exposed commit is inaccessible from normal public refs; remember deletion from history cannot remove copies already downloaded.
- [ ] Revoke and rotate **any credentials that might have appeared in the previous commit** at their respective providers, including Tesla application secrets/tokens, the MCP OAuth provider, Redis storage tokens, deployment keys, and any optional mapping API keys. Only the credential owner can attest to rotation.
- [ ] Confirm no private VIN, address, personal route, authentication subject, private key, current deployment ID, or personal charging contract appears in the release.

## Test and deploy safety

- [ ] Run `node simulator/prepare-artifact.mjs` in a disposable test checkout (this regenerates ignored `simulator/dist`).
- [ ] Run `node --test simulator/*.test.mjs` from the repository root.
- [ ] Run `(cd simulator && go test ./... && go build ./... && go vet ./...)` with suitable Go version and dependencies.
- [ ] Run the Redis-backed integration suite in an isolated environment; do not point integration tests at production Redis or a Tesla account.
- [ ] Verify a successful GitHub Actions run on the final commit/branch and inspect failures, skipped tests, and dependencies.
- [ ] Confirm no live Tesla commands, implicit `wake_up`, deployments, provider registration, or paid API calls were triggered by validation.
- [ ] Verify read-only MCP login against a **dedicated test deployment** with its own subject. Confirm writes are disabled and that incorrect issuer, subject, audience and scopes are rejected.

## Legal, documentation and release

- [ ] Confirm the MIT license covers original code and retain third-party notices where required.
- [ ] Validate applicable licenses and required attribution for OpenStreetMap and French, German, Italian and Swiss station data; Swiss non-commercial restrictions may require additional permission for commercial deployments.
- [ ] Verify current Tesla Fleet API developer terms and limits; do not imply Tesla endorsement or hardware compatibility.
- [ ] Review [client compatibility](CLIENT_COMPATIBILITY.md) and [configuration](CONFIGURATION.md) against the actual onboarding experience for a new operator.
- [ ] Explicitly decide when to make the repository public **after** the checks; do not change production environment settings as part of repository publication.

**Release result:** `NOT APPROVED` until every applicable mandatory box above has been checked with real evidence. Source code release is distinct from production deployment and ChatGPT plugin/workspace publication.

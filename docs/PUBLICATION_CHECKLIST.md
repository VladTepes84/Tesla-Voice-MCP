# Public release gate

## Review scope

Before publication, verify not only the code but also the **landing README, beginner onboarding, technical operator manual, third-party license terms and the correctness of the project's claims relative to Tesla Fleet API**. A successful automated scan is necessary but not sufficient.

The current documentation deliberately labels the 16-stop planner **offline-tested** and its vehicle transport **experimental**. That distinction must survive release edits.

**Evidence reference:** [Evidence](EVIDENCE.md) · [Beginner's Guide](BEGINNERS_GUIDE.md) · [Why MCP](WHY_MCP.md) · [Operator runbook](OPERATOR_RUNBOOK.md).


This checklist is deliberately incomplete until the maintainer performs the indicated actions. Preparing a patch is **not** approval to change repository visibility.

## Source and history

- [ ] Confirm the target is the sanitized public-release candidate repository, not a private production repository or its deployment.
- [ ] Review all tracked files, reachable branches, tags, releases, workflow artifacts, PRs, and commit author metadata for secrets and personal information.
- [ ] Re-run a dedicated secret scanner against the working tree **and all reachable Git history**, then manually review suspicious fixtures and high-entropy strings. A regex scan alone is insufficient.
- [ ] If the review identifies a genuine previously exposed commit or private data, verify which reachable refs, artifacts and external copies remain accessible. Consult GitHub Support when appropriate; history rewriting alone does not revoke copied secrets.
- [ ] **If actual exposure is established or reasonably suspected**, the credential owner must revoke/rotate affected credentials with the corresponding Tesla, OAuth, Redis, hosting or map provider and document the verification privately. Do not assert that a credential was exposed without evidence.
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
- [ ] Review [client compatibility](CLIENT_COMPATIBILITY.md) and [configuration](CONFIGURATION.md) against a clean-room onboarding test by a new operator, including external OAuth registration and a first read-only MCP result.
- [ ] Confirm beginner, technical, marketing and demo documents make the same claims; all examples must be synthetic, all Markdown links valid and all public-facing prose in English.
- [ ] Check that the project is presented as MCP orchestration layered over Fleet API, not a new Tesla API or a guarantee of 75 live vehicle commands.
- [ ] Explicitly decide when to make the repository public **after** the checks; do not change production environment settings as part of repository publication.

**Release result:** `NOT APPROVED` until every applicable mandatory box above has been checked with real evidence. Source code release is distinct from production deployment and ChatGPT plugin/workspace publication.

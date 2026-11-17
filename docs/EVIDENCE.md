# Evidence, readiness and verification boundaries

**Client evidence boundary:** vendors may document custom remote MCP features, but no clean-room test of this release has certified Claude/Gemini/Grok compatibility or their voice modes. Record client-specific results in [Compatibility matrix](COMPATIBILITY_MATRIX.md). A documented possibility or a successful local server test is not proof of a vendor client connection.

This document tells readers **what source code and tests establish—and what they do not**. It is intended for maintainers, auditors, integrators and users who need a precise, non-marketing assessment.

**Reference:** sanitized release candidate, inspected on 2026-11-17. For reproducibility, pin the exact Git commit visible on the repository page and verify the current CI runs; do not rely on the review date as a live-deployment attestation.

## Credential-free clean-room smoke test

The source includes `simulator/clean-room-install.test.mjs`, which starts a localhost-only adapter and exercises actual MCP handlers with **ephemeral synthetic OAuth**. It verifies protected-resource discovery, JWT issuer/audience/subject/scope/expiry enforcement, tool listing, synthetic battery read and rejection of unavailable vehicle commands.

**Verified offline (2026-11-17):** [Node/Go/Redis CI run](https://github.com/VladTepes84/Tesla-Voice-MCP/actions/runs/44103169174), 537 Node tests passing, plus [Gitleaks scan](https://github.com/VladTepes84/Tesla-Voice-MCP/actions/runs/44103169101), 11 commits without detected leaks. This does **not** verify a real Tesla account, cloud deployment or any AI provider's OAuth client. Full details: [Clean-room simulation](CLEAN_ROOM_SMOKE.md).

## Developer-reported real-vehicle experience

The developer reports operational use and online testing on their own Tesla Model 3 in October 2026, including successful tests of all 75 catalog operations and navigation with up to 16 destinations. These are **developer declarations**, not independent verification. See the [real vehicle test record](REAL_VEHICLE_TESTING.md) for the 75-operation list and recorded limitations. The available account does not specify dates, vehicle/firmware, execution conditions, or the exact software revision and transport configuration used. Offline synthetic tests and this real-vehicle report are separate evidence. Availability still depends on configuration, permissions, vehicle and the pinned SDK's transport limits.

## Capability and evidence matrix

| Claim | Source reference | Evidence class | Unproven or conditional part |
| --- | --- | --- | --- |
| MCP tool catalog with authorization | `simulator/lib/real-mcp.mjs`, `mcp-tool-auth.mjs` | Implemented in source; offline auth tests | Real client connection in every product/plan |
| 38 named MCP tools documented | `docs/FEATURES.md`, `docs/TOOLS_REFERENCE.md`, tool definitions | Source inventory | All tools visible simultaneously or usable in any deployment |
| 75 command names cataloged | `simulator/lib/operation-plans.mjs` | Source inventory; developer confirms successful real-vehicle tests of all 75 operations | Independent audit, exact tested revision and support on each Tesla; eight default SDK transports unavailable |
| Encrypted account state and private preferences | `simulator/lib/store.mjs`, `security.mjs` | Implemented and covered by local tests | Deployed infrastructure security or regulatory compliance |
| Cached vehicle data and app reading history | `simulator/lib/real-mcp.mjs`, Tesla/store modules | Implemented in source | Continuous telemetry or perfect freshness |
| Live Tesla reads | Tesla integration and access gates | Implemented software path | Any particular vehicle/account success, latency or charges |
| OSM/Photon/OSRM and national station sources | Map, road-trip and station adapters | Implemented software integrations | Service availability, completeness, pricing and data license reuse |
| Energy and cost comparisons | `energy-estimate.mjs`, `charge-cost-comparison.mjs` | Deterministic estimates with supplied inputs | Certified vehicle consumption/BMS model or guaranteed monetary savings |
| DC/HPC CCS2 charging route planner | `charging-route.mjs` | Implemented planner and mock tests | Charger occupancy, actual route feasibility and real-time prices |
| 2–16 destination navigation-only preparation | `smart-trip.mjs`, `google-waypoints.mjs`, navigation tests | Source and offline tests; developer reports live navigation up to 16 destinations | Independent confirmation and behavior in other configurations |
| Energy-mode smart trip max 8 intermediate stops | `smart-trip.mjs` | Source schema/runtime constraint | That a chosen route is practical |
| Guarded command execution and receipts | `operation-plans.mjs`, command authorization/lifecycle | Software paths and mock tests | Physical actuation on arbitrary firmware/model |
| Independent secret scanning | `.github/workflows/release-secret-scan.yml` | CI process; check exact latest run | A complete manual security audit or proof no secrets exist anywhere |
| Consumer onboarding | English documentation | Published instructions | Independent end-to-end clean-room installer success |

## Catalog metadata and evidence

The catalog returns `vehicle_test_status: developer_reported_tested` for each of its 75 operations, including GPS navigation. This records the developer's statement, not independent verification, an attestation for this exact revision or transport, or a guarantee for another vehicle. The older value `not_tested` did not distinguish a developer declaration from independently verified evidence. `vehicle_support: not_verified` and navigation-specific verification fields remain separate: general compatibility and the exact transport have not been independently established. `mock_validation: not_attested_per_command` separately describes automated test coverage.

## Status vocabulary

- **IMPLEMENTED:** present in current source.
- **VERIFIED_OFFLINE:** tested with deterministic mocks, synthetic fixtures or isolated integration infrastructure.
- **DEVELOPER_REPORTED:** the developer describes an outcome; no independent verification or detailed test record is implied.
- **PROVIDER_ACCEPTED:** actual external API acknowledged the request; not proof of physical outcome.
- **VEHICLE_VERIFIED:** independently observed vehicle state or display, with model/firmware/time/operation scope.
- **ESTIMATED:** calculation using supplied assumptions and data provenance.
- **UNVERIFIED:** not yet confirmed in the required environment.

Do not upgrade a claim's evidence level merely because a command has an SDK transport or a unit test.

## Suggested acceptance matrix for independent deployments

| Stage | What to verify | Expected evidence |
| --- | --- | --- |
| 0. Offline | Node test suite, Go test/build/vet, isolated Redis suite | CI run on the pinned commit with no failures |
| 1. Auth | Wrong issuer/audience/subject/scope rejected | Sanitized test results |
| 2. MCP client | Custom server OAuth and intended tool discovery | Client-specific test report |
| 3. Tesla linking | Authorized operator account, correct scopes and vehicle | Private connection status; no secret disclosure |
| 4. Cached reads | Timestamp and no implicit wake | Tool result with recorded provenance |
| 5. Live read | One explicitly requested live response | Tesla response and controlled quota observation |
| 6. Local planner | Known mathematical fixtures, routing and consent | Inputs/outputs with tolerances and sources |
| 7. Single command | Explicit user request, receipt and physical result | Independent on-car observation |
| 8. Multipoint | Exact stop order, no duplicates, no partial replacement | Full in-car display inspection, not just `accepted` |

## What a successful CI run means

The repository's workflows test Node functionality, Go build/test/vet and an isolated Redis integration subset. Secret scanning can identify recognizable credentials in reachable history. These are strong **offline engineering signals**, but not an end-to-end Tesla, OpenAI client, map-provider or deployment test.

For the current source and workflow history, inspect the [project's GitHub Actions page](../.github/workflows/) and [release gate](PUBLICATION_CHECKLIST.md). Do not copy a CI count across commits without checking that commit's run.

## Open verification items

- Independent, clean-room installation by an operator unfamiliar with the project.
- Real Tesla read/command acceptance in each intended supported environment.
- Independent vehicle-side verification of the exact 2–16 stop behavior and documentation of the developer-reported test conditions.
- Current client compatibility across desired plans and workspaces.
- Third-party dataset licensing and commercial reuse review for each selected provider.
- Formal security review, provider cost ceilings and operational incident response under production conditions.

These are evidence gaps, **not** reasons to pretend the functions do not exist. They set the boundary of what can be claimed responsibly.

See [Why MCP](WHY_MCP.md) · [Security](SECURITY_MODEL.md) · [Operator runbook](OPERATOR_RUNBOOK.md) · [Publication checklist](PUBLICATION_CHECKLIST.md).

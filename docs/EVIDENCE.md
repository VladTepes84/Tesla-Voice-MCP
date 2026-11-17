# Evidence, readiness and verification boundaries

**Client evidence boundary:** vendors may document custom remote MCP features, but no clean-room test of this release has certified Claude/Gemini/Grok compatibility or their voice modes. Record client-specific results in [Compatibility matrix](COMPATIBILITY_MATRIX.md). A documented possibility or a successful local server test is not proof of a vendor client connection.

This document tells readers **what source code and tests establish—and what they do not**. It is intended for maintainers, auditors, integrators and users who need a precise, non-marketing assessment.

**Reference:** sanitized release candidate, inspected on 2026-11-17. For reproducibility, pin the exact Git commit visible on the repository page and verify the current CI runs; do not rely on the review date as a live-deployment attestation.

## Capability and evidence matrix

| Claim | Source reference | Evidence class | Unproven or conditional part |
| --- | --- | --- | --- |
| MCP tool catalog with authorization | `simulator/lib/real-mcp.mjs`, `mcp-tool-auth.mjs` | Implemented in source; offline auth tests | Real client connection in every product/plan |
| 38 named MCP tools documented | `docs/FEATURES.md`, `docs/TOOLS_REFERENCE.md`, tool definitions | Source inventory | All tools visible simultaneously or usable in any deployment |
| 75 command names cataloged | `simulator/lib/operation-plans.mjs` | Source inventory | 75 commands physically tested or supported by each Tesla |
| Encrypted account state and private preferences | `simulator/lib/store.mjs`, `security.mjs` | Implemented and covered by local tests | Deployed infrastructure security or regulatory compliance |
| Cached vehicle data and app reading history | `simulator/lib/real-mcp.mjs`, Tesla/store modules | Implemented in source | Continuous telemetry or perfect freshness |
| Live Tesla reads | Tesla integration and access gates | Implemented software path | Any particular vehicle/account success, latency or charges |
| OSM/Photon/OSRM and national station sources | Map, road-trip and station adapters | Implemented software integrations | Service availability, completeness, pricing and data license reuse |
| Energy and cost comparisons | `energy-estimate.mjs`, `charge-cost-comparison.mjs` | Deterministic estimates with supplied inputs | Certified vehicle consumption/BMS model or guaranteed monetary savings |
| DC/HPC CCS2 charging route planner | `charging-route.mjs` | Implemented planner and mock tests | Charger occupancy, actual route feasibility and real-time prices |
| 2–16 destination navigation-only preparation | `smart-trip.mjs`, `google-waypoints.mjs`, navigation tests | Source and offline test coverage | All 16 waypoints on Tesla display |
| Energy-mode smart trip max 8 intermediate stops | `smart-trip.mjs` | Source schema/runtime constraint | That a chosen route is practical |
| Guarded command execution and receipts | `operation-plans.mjs`, command authorization/lifecycle | Software paths and mock tests | Physical actuation on arbitrary firmware/model |
| Independent secret scanning | `.github/workflows/release-secret-scan.yml` | CI process; check exact latest run | A complete manual security audit or proof no secrets exist anywhere |
| Consumer onboarding | English documentation | Published instructions | Independent end-to-end clean-room installer success |

## Status vocabulary

- **IMPLEMENTED:** present in current source.
- **VERIFIED_OFFLINE:** tested with deterministic mocks, synthetic fixtures or isolated integration infrastructure.
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
- Vehicle-side verification of the exact 2–16 stop behavior.
- Current client compatibility across desired plans and workspaces.
- Third-party dataset licensing and commercial reuse review for each selected provider.
- Formal security review, provider cost ceilings and operational incident response under production conditions.

These are evidence gaps, **not** reasons to pretend the functions do not exist. They set the boundary of what can be claimed responsibly.

See [Why MCP](WHY_MCP.md) · [Security](SECURITY_MODEL.md) · [Operator runbook](OPERATOR_RUNBOOK.md) · [Publication checklist](PUBLICATION_CHECKLIST.md).

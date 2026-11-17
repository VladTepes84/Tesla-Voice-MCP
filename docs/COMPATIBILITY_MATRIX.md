# MCP and voice compatibility verification matrix

This is a **test plan and current evidence register**, not a certification. Vendor documentation confirms various custom remote MCP capabilities; **no independently documented end-to-end test of this release with all named clients has been performed**.

**Checked documentation:** 2026-11-17. Revalidate vendor entitlements, connection UI and protocol support whenever testing.

## Evidence labels

- **VENDOR-DOCUMENTED:** The vendor documents a relevant remote MCP feature.
- **EXPECTED / UNTESTED:** We expect a compatible route, conditional on this server's exact OAuth and tool protocol. No successful client/server test evidence on this branch.
- **VERIFIED IN TEST:** A repeatable sanitized client-specific test and its outcome are captured.
- **LIVE VERIFIED:** Authenticated Tesla request or vehicle operation separately observed and recorded.
- **VOICE VERIFIED:** A specific voice mode successfully invokes a named MCP tool with a captured/sanitized trace.

## Matrix

| AI client / surface | Vendor remote MCP feature | OAuth + tools/list with THIS server | Read-only tool tested? | Voice tool invocation tested? | Current status |
| --- | --- | --- | --- | --- | --- |
| ChatGPT eligible custom MCP workspace | Vendor-documented | Not independently attested here | Not a clean-room test | **No; vendor general FAQ currently says Voice mode does not support apps** | **Expected / untested** |
| Claude / Claude Desktop | Vendor-documented | Not tested | Not tested | Not tested | **Expected / untested** |
| Claude Code | Vendor-documented | Not tested | Not tested | Not a built-in voice path | **Expected / untested** |
| Gemini CLI | Vendor-documented | Not tested | Not tested | Not a built-in voice path | **Expected / untested** |
| Gemini Apps / Spark custom connected app | Vendor-documented where eligible | Not tested | Not tested | Gemini Live not tested | **Expected / untested** |
| Grok via xAI Remote MCP SDK/API | Vendor-documented | Not tested; token/claims must align | Not tested | xAI Speech-to-Speech supports remote MCP at platform level; this server not tested | **Expected / untested** |
| Grok consumer custom connector | Vendor-documented where supported | Not tested | Not tested | Not tested | **Expected / untested** |
| Other MCP clients | Client-dependent | Not tested | Not tested | Not tested | **Potential / untested** |

### Baseline test procedure — per client, no real Tesla required

1. Record app/client name, version, plan/workspace, region and date.
2. Deploy an isolated test instance; do **not** reuse a production Tesla token or Redis database.
3. Verify HTTPS and protected-resource discovery; confirm unauthenticated access fails.
4. Complete MCP OAuth using the client's supported flow; verify issuer, audience, allowed subject and scopes.
5. Inspect `tools/list`, including tool names, input schemas and access limitations.
6. Execute `get_connection_status` or `estimate_trip_energy` with synthetic values.
7. Confirm a denied `vehicle:control` action remains denied even if requested by an AI prompt.
8. Compare protocol/HTTP error handling and tool-result rendering.
9. If the client supports it, run a **separately controlled voice-to-MCP read-only test**. Save sanitized evidence that a tool was actually invoked, not just a spoken answer.
10. Record result, precise limitation and evidence link/commit; never invent a live Tesla result.

### Optional real vehicle acceptance (separate authorization)

Do not combine the compatibility smoke test with a live command. A single explicitly authorized vehicle operation should be tested separately, while safe/parked, with server receipt and independent physical observation. Multipoint routes additionally require an exact stop-by-stop in-car inspection.

## What to record

```text
Client / version / plan:
Date / platform:
MCP transport + negotiated version:
OAuth issuer class / audience match / requested scopes: (no token values)
tools/list outcome:
Read-only call + synthetic inputs:
Voice tool invocation (yes/no/not supported/not attempted):
Allowed write tests: none in basic compatibility test
Observed error codes and workaround:
Evidence link:
Final status: VERIFIED IN TEST / EXPECTED-UNTESTED / BLOCKED
```

Before marking a test as verified, add reproducible evidence; CI unit tests alone validate the server and do not certify a particular vendor client.

See [AI clients](AI_CLIENTS.md) · [Voice](VOICE_USAGE.md) · [Security](SECURITY_MODEL.md) · [Evidence](EVIDENCE.md).

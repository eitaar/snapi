# Content Runtime Feasibility Report

- Build ID: `8dd50222`
- Started at: `2026-08-11T06:07:32.790Z`

## Verified assets

| Filename | SHA-256 | Size |
|---|---|---:|
| 41f8a232e0dafca526c7.js | 9ea45314e4f13777330816567d68b146e9a3e4a02973ed54560a3ca65463980b | 8977740 |
| 4577c38d10436a1f90f1.chunk.js | e96e503d349d315c99b396bab35af25fbf6714c35fc73707df0c02accca10a13 | 66137 |
| 269b973c69f9ca2dcc93.chunk.js | 8bcca75a45b14bc18af218f69f273109a944adb5c31b902370ac67b3e265c81f | 1550593 |
| 903641c0ba985b2dcd13.wasm | 2ce913a96d256605ea3b9998e71a65ee93b4f736fa4289d27490ed7fa5a95cd5 | 12326439 |

## Checks

| Check | Status | Duration ms | Error code | Safe error |
|---|---|---:|---|---|
| assets_verified | passed | 0 |  |  |
| worker_started | passed | 0 |  |  |
| globals_installed | passed | 0 |  |  |
| storage_imported | passed | 0 |  |  |
| wasm_instantiated | passed | 0 |  |  |
| modules_resolved | passed | 0 |  |  |
| content_envelope_created | failed | 0 | CRYPTO_RUNTIME_FAILED | Direct Node MessagingCoreService transport is not authorized outside the browser connection context |

## Live transport evidence

- Edge extension access verified the logged-in page at `https://www.snapchat.com/web`.
- A browser-issued 292-character token matched the Bearer token on a successful `DeltaSync` POST.
- The successful browser `DeltaSync` POST returned HTTP 200.
- Replaying that exact current POST body, non-secret headers, and token from Node within seconds returned HTTP 401.
- The official Worker generated `SyncConversations` and `GetGroups`; both returned HTTP 401 from Node.
- No `CreateContentMessage` request was produced and no live CLI message was sent during this gate.

The direct-runtime feasibility gate therefore fails for build `8dd50222`. The evidence is consistent with browser connection or attestation binding, but does not identify which browser-only signal the server validates. Per the design boundary, the implementation must not silently replace direct execution with browser automation.

## Read-only auth-gap probe safety gate

- The private probe input and session export were present and their file timestamps were within two minutes.
- The stored request was `POST` over HTTPS to `web.snapchat.com`, but its path was `/com.snapchat.deltaforce.external.DeltaForce/DeltaSync`.
- The probe allowlist intentionally accepts only `/messagingcoreservice.MessagingCoreService/DeltaSync` and `/messagingcoreservice.MessagingCoreService/GetGroups`.
- No live request was made because the stored path did not match the allowlist; no conclusion about Cookie sufficiency was drawn.

## CLI-only auth renewal diagnostic gate

The separate diagnostic command:

```powershell
$env:SNAP_LIVE_TESTS='1'
node dist/cli/index.js debug auth-renewal --cli-only
```

is opt-in and read-only. It permits at most one CLI-only renewal attempt plus
one read-only verification request, does not persist refreshed session state,
and emits only sanitized result/status/capability metadata.

Interpret the result values as follows:

- `renewed`: this diagnostic execution completed one local refresh and the one
  read-only verification request succeeded. It does not claim that future
  requests, other operations, or a different authentication epoch will also
  succeed.
- `browser-context-required`: the renewal or verification path hit a
  browser-bound outcome, including the expected `303`/`403` class of responses.
  For this build/context, the CLI-only path should remain fail-closed.
- `profile-unavailable`: local Brave/DBSC profile state required for the
  CLI-only path was not available to the host process.
- `rejected`: the CLI-only renewal path ran, but the single verification
  request still failed. This is not evidence that retries, extra probes, or
  credential replay should be added.

Like the auth-gap probe, this diagnostic gate must not print or persist raw

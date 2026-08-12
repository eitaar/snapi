# Content Runtime Feasibility Report

- Build ID: `8dd50222`
- Started at: `2026-08-12T02:38:12.020Z`

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
| assets_verified | passed | 101 |  |  |
| worker_started | passed | 4 |  |  |
| globals_installed | failed | 510 | AUTH_CONTEXT_UNAVAILABLE | SSO refresh requires a browser-managed authentication context |

## CLI-only auth renewal diagnostic gate

The separate diagnostic command:

```powershell
$env:SNAP_LIVE_TESTS='1'
node dist/cli/index.js debug auth-renewal --cli-only
```

is opt-in and read-only. It permits at most one CLI-only renewal attempt plus
one read-only verification request, does not persist refreshed session state,
and emits only sanitized result/status/capability metadata.

The read-only verification fixture is accepted only from the configured
session directory as `edge-delta-probe.json`, with exact non-secret bindings
for the configured account, build, and session `exportedAt` epoch. Missing,
legacy-unbound, stale, or mismatched fixtures fail before network traffic.

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
Cookie, Bearer, token, proof, or request/response body material.

# Content Runtime Feasibility Report

- Build ID: `8dd50222`
- Started at: `2026-08-12T10:14:19.046Z`

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
| assets_verified | passed | 448 |  |  |
| worker_started | passed | 6 |  |  |
| globals_installed | passed | 4941 |  |  |
| storage_imported | passed | 0 |  |  |
| wasm_instantiated | passed | 0 |  |  |
| modules_resolved | passed | 0 |  |  |
| content_envelope_created | failed | 2 | SESSION_REEXPORT_REQUIRED | Session export is missing login-time messaging key initialization state |

## Gateway / duplex diagnosis

The CLI now supplies the official Worker with the page Origin required by the
standard Node WebSocket implementation. This is covered by an isolated wrapper
test; it does not add Cookie, Bearer, DBSC, attestation, user-agent, or TLS
fingerprint values.

The read-only Gateway handshake probe returned:

| Check | Status | Classification | Protocol category |
|---|---:|---|---|
| standard WebSocket Upgrade | 401 | authorization-rejected | snap-ws-auth |

The same session's read-only Friends sync returned HTTP 200. The pinned browser
bundle uses one auth-token getter for Messaging and Gateway, and three successful
browser HARs show the same 292-byte token in both places. The CLI now mirrors a
successful SSO result into both compatibility fields, maintains it while a
long-running command is open, and supplies it again on reconnect.

A freshly issued CLI SSO token still returned `401` when tested immediately by
the read-only Upgrade probe. Matching the successful Brave request's ordinary
headers did not change that result; neither did issuing the token without
attestation or with the captured initial `scuid` sentinel. A temporary clean
Brave context also rejected the CLI-issued token. Therefore token propagation
is repaired, but the remaining Gateway failure is a distinct browser/transport
or token-issuance-context boundary. A TLS-impersonating native helper is the
next CLI-only experiment if direct Gateway support is required. No message or
Snap was sent during this diagnosis.

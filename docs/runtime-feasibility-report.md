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

The same session's read-only Friends sync returned HTTP 200. Therefore the
current failure is not a general HTTP session failure and is not explained by
the CLI opening Gateway twice. The captured Gateway subprotocol credential is
rejected by the Gateway endpoint. SSO/Web-session renewal does not produce a
new Gateway credential; a successful Gateway handshake in a fresh HAR is still
required. No message or Snap was sent during this diagnosis.

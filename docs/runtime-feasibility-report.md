# Content Runtime Feasibility Report

- Build ID: `8dd50222`
- Started at: `2026-08-12T14:19:44.362Z`

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
| assets_verified | passed | 178 |  |  |
| worker_started | passed | 18 |  |  |
| globals_installed | passed | 3115 |  |  |
| storage_imported | passed | 0 |  |  |
| wasm_instantiated | passed | 0 |  |  |
| modules_resolved | passed | 0 |  |  |
| content_envelope_created | failed | 1 | CRYPTO_RUNTIME_FAILED | Official messaging Worker call failed |

## Auth-binding investigation (sanitized)

The existing operator capture private/fresh7.har was summarized offline on
2026-08-14 with epoch label fresh7. The parser accepted the pinned
8dd50222 marker, Gateway/Messaging token equality was true, and no
credential value was emitted.

| Context | Epoch | Operation | Endpoint | Protocol | Status | Body bytes | Body SHA-256 | Token equals epoch baseline | Route matches | Process matches | Connection matches | Conclusion |
|---|---|---|---|---|---:|---:|---|---|---|---|---|---|
| brave-natural | fresh7 | messaging-read | /messagingcoreservice.MessagingCoreService/DeltaSync | h3 | 200 | 65 | eeef387cb18fbaf8d7819dc8afa02334e4359eed260a7dd100b146ebed06b6cc | true | unavailable | unavailable | unavailable | browser baseline |
| brave-natural | fresh7 | gateway-handshake | /snapchat.gateway.Gateway/WebSocketConnect | websocket | 101 | — | — | true | unavailable | unavailable | unavailable | browser baseline |
| node-http1 | fresh7 | messaging-read | /messagingcoreservice.MessagingCoreService/DeltaSync | http/1.1 | 401 | 65 | eeef387cb18fbaf8d7819dc8afa02334e4359eed260a7dd100b146ebed06b6cc | true | unavailable | unavailable | unavailable | rejected |
| node-http2 | fresh7 | messaging-read | /messagingcoreservice.MessagingCoreService/DeltaSync | h2 | 401 | 65 | eeef387cb18fbaf8d7819dc8afa02334e4359eed260a7dd100b146ebed06b6cc | true | unavailable | unavailable | unavailable | rejected |
| dotnet-http3 | fresh7 | messaging-read | /messagingcoreservice.MessagingCoreService/DeltaSync | h3 | 401 | 65 | eeef387cb18fbaf8d7819dc8afa02334e4359eed260a7dd100b146ebed06b6cc | true | unavailable | unavailable | unavailable | rejected |
| node-gateway | fresh7 | gateway-handshake | /snapchat.gateway.Gateway/WebSocketConnect | websocket | 401 | — | — | true | unavailable | unavailable | unavailable | rejected |

The browser baseline contained one successful Gateway 101, five
allowlisted read-only Messaging 200 entries, ten Messaging write-path
entries counted as a red flag, Gateway origin https://www.snapchat.com, no
Gateway Cookie/Authorization header, and Messaging protocol h3. The write
entries were not used as success evidence.

Reload, browser-process restart, --disable-quic h2 capture, page replay,
Worker replay, and bootstrap perturbation were not run in this pass because
no new operator-exported HARs were supplied. Therefore the narrowest
supported live conclusion is insufficient-evidence: the results establish
that the captured Browser request succeeds while Node HTTP/1.1, Node h2,
Node Gateway, and the previously recorded .NET h3 replay fail, but they do
not isolate token freshness, connection instance, browser process/profile,
QUIC, TLS/client identity, browser principal, or bootstrap sequence.

No conclusion here claims a DBSC key, attestation mechanism, TLS fingerprint,
or server-side registration detail. The diagnostic layer does not make Chat,
Snap, Gateway receive, or Gateway reconnect work by itself.

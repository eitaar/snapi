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

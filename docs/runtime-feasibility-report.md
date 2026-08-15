# Content Runtime Feasibility Report

- Build ID: `da4d065e`
- Started at: `2026-08-15T07:07:06.937Z`

## Verified assets

| Filename | SHA-256 | Size |
|---|---|---:|
| 9c7241693746d9324c46.js | 596fd25e3efa6e514d26953e7f92ce74e3600951a15fab05eee9361422bc82ee | 8956445 |
| 7d1e753bedce8c25fc95.chunk.js | 1e63696c9e8fdb410a39c9d11b476a2bcaee0da13263e1627b906240ec889dbe | 66305 |
| 4f0e6933a127015ffe00.chunk.js | a4302badad70a39f777381cd98542e2ac47499d8c11a2b33a35ae8e0e851f668 | 1418707 |
| 903641c0ba985b2dcd13.wasm | 2ce913a96d256605ea3b9998e71a65ee93b4f736fa4289d27490ed7fa5a95cd5 | 12326439 |

## Checks

| Check | Status | Duration ms | Error code | Safe error |
|---|---|---:|---|---|
| assets_verified | passed | 129 |  |  |
| worker_started | passed | 3 |  |  |
| globals_installed | failed | 2201 | AUTH_CONTEXT_UNAVAILABLE | SSO token refresh requires a valid exported authentication context |

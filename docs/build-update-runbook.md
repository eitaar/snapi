# Build update runbook

Do not change the supported build identifier or hashes from a single capture.
Use managed accounts and repeat the evidence sequence on two independent fresh
sessions.

1. Record the Snapchat Web revision and download every required JavaScript and
   WASM asset without rewriting it.
2. Record filename, byte size, and SHA-256; update the compatibility manifest.
3. Verify Worker boot, browser globals, IndexedDB import, WASM imports/exports,
   and anchored module shapes with network writes disabled.
4. Capture one Chat send and reply. Regenerate only sanitized protocol fixtures.
5. Capture JPEG and PNG native Snap sends. Confirm getUploadLocations, encrypted
   CDN PUT, updated SnapDoc encryption metadata, and CreateContentMessage order.
6. Verify open, replay, and screenshot branches. Unknown shapes remain unknown;
   do not infer a new mapping from field values alone.
7. Verify clean close, abnormal reconnect after three seconds, offline
   suppression, and online recovery.
8. Restart from persisted crypto state and repeat Chat and photo sends.
9. Run typecheck, all tests, coverage, build, managed live tests, and a tracked
   file secret scan.
10. Repeat steps 3-9 with a second fresh session before declaring compatibility.

Never commit raw HARs, WebSocket frames, credentials, friend device keys,
images, signed URLs, or proprietary asset files.

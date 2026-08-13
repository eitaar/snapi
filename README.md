# Snapchat private Web API CLI

Experimental Node.js/TypeScript CLI for one operator-controlled Snapchat Web
session. It executes the pinned Snapchat JavaScript/WASM runtime to create
protected message envelopes. The current supported Web build is only
`8dd50222`.

This uses an undocumented private API. Snapchat can change the bundle,
authentication, protocol, or account policy at any time. Use only managed test
accounts and conversations you control. The project does not automate account
recovery, CAPTCHA, device approval, or rate-limit bypass. It never extracts or
spoofs browser-managed session keys.

## Requirements and setup

- Node.js 24 or newer
- A session export from an already logged-in Snapchat Web session (for account,
  build, and runtime state)
- The exact four pinned assets under `private/assets/`
- A fresh HAR containing successful Messaging, Gateway, accounts SSO, and
  `/web-chat-session/refresh` traffic from the same login epoch

```powershell
npm install
npm run build
Copy-Item .env.example .env
```

Set `SNAP_SESSION_FILE`, `SNAP_ASSET_DIR`, `SNAP_ACCOUNT_ID`, and
`SNAP_BUILD_ID=8dd50222` in `.env`. Keep `.env`, `private/`, HAR files, assets,
and images out of source control.

For a short-lived manual browser-cookie diagnostic, set `SNAP_COOKIE_HEADER`
to the Cookie header copied from DevTools. Set `SNAP_SSO_COOKIE_HEADER`
separately when the accounts-domain SSO request uses a different Cookie header.
These values are never logged, but they are session credentials and must not be
committed or pasted into chat.

Once `session refresh-har` has imported a complete authentication context, the
persisted session becomes authoritative and these static environment Cookie
values no longer override later Cookie rotations. They remain a bootstrap
fallback for legacy session exports without HAR-managed SSO headers.

Automatic renewal mirrors the two observed browser timers. Roughly every ten
minutes the CLI runs the pinned official Web Attestation WASM and posts to
`accounts/sso`; its successful response replaces the shared Messaging/Gateway
token and is pushed into the official Worker. A timer keeps that renewal active
for long-running watch commands, and Gateway reconnect obtains auth through the
same provider. Roughly hourly the CLI also posts the current token and Web
Cookie to `/web-chat-session/refresh`; that empty-response heartbeat preserves
the token and extends the Web session. The captured non-DBSC flow has no Brave
dependency. If renewal rejects the exported login context, a fresh login HAR
is required.

## Commands

```powershell
node dist/cli/index.js session check
node dist/cli/index.js session login
node dist/cli/index.js session import private/fresh-session.json
node dist/cli/index.js session refresh-har private/fresh.har
node dist/cli/index.js chat send <recipient-uuid> "test message" --conversation-id <conversation-uuid>
node dist/cli/index.js chat watch --json
node dist/cli/index.js snap send <recipient-uuid> photo.png --conversation-id <conversation-uuid>
node dist/cli/index.js snap watch --output-dir .snap-incoming --json
node dist/cli/index.js friends list --json
node dist/cli/index.js friends list --query <username-or-user-id> --json
node dist/cli/index.js friends list --easy --json
node dist/cli/index.js gateway status
node dist/cli/index.js debug doctor --runtime
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug gateway-handshake --json
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-renewal --cli-only
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-gap --request private/edge-delta-probe.json --session private/session.json --mode node-web-cookie --auth-epoch edge-capture-1
node dist/cli/index.js debug auth-binding har --file private/fresh7.har --epoch fresh7
node dist/cli/index.js debug auth-binding classify --observations tests/fixtures/auth-binding-observations.json
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-binding probe --request private/edge-delta-probe.json --mode node-http2 --epoch fresh7
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-binding gateway --mode node-gateway --epoch fresh7
```

`session check` performs shape, account, lock, asset hash, module, and WASM
checks without authenticated network traffic. `session refresh-har` extracts
the browser-issued shared Messaging/Gateway token, along with the Web Cookie,
accounts context, and restricted heartbeat headers from a fresh sensitive HAR,
then atomically persists them. The importer rejects captures where successful
Messaging and Gateway requests use different tokens. Later successful
`accounts/sso` responses replace the shared token automatically.
`session import` validates the export and every declared asset hash while
holding the account's single-writer lock, then atomically installs it.

`session login` contains the prompt-independent credential/OTP state machine
and masks password/OTP input when the terminal supports raw mode. Password and
OTP buffers are cleared after each submission and are never persisted. The
default pinned build currently has no verified WebLogin protobuf contract in
this checkout, so the command stops with `UNSUPPORTED_BUILD` before prompting
for credentials; it will not guess fields from a HAR. Use `session import` or
`session refresh-har` until a sanitized, build-verified WebLogin adapter is
installed.

Session state written by import, HAR refresh, login finalization, or automatic
renewal is stored in a Windows DPAPI-sealed envelope. A legacy plaintext
format-version-1 file is accepted for validation and is sealed on the first
explicit migration write; its plaintext atomic backup is removed after the
sealed write succeeds.

Chat and photo commands acquire a single-writer account lock, verify the pinned
build before network access, initialize the official runtime, send once, and
persist updated cryptographic state. Photo input is limited to validated JPEG
or PNG files up to 10 MiB. Media is AES-encrypted before the signed Snap CDN
upload; signed URLs and key material are never emitted.

PNG Photo Snap and text Chat are one-shot operations. A confirmed server result
is reported as success even if final Worker cleanup needs forced termination.
An ambiguous result is reported as `DELIVERY_UNCONFIRMED` and is never retried
automatically; rerunning the command is a separate operator decision.

`chat watch` asks the official messaging runtime to synchronize the feed,
decodes only official text MessageContent values, persists updated
cryptographic state before emitting plaintext, and deduplicates by server
message ID. `snap watch` uses the pinned official media resolver to download
and decrypt incoming Snap media, then writes it to the explicitly selected
output directory; it never prints media bytes. `gateway status` performs a
real Gateway connection handshake and reports the selected connection state.
Open, replay, screenshot, and unknown Gateway branches remain available
through the public event stream.

`friends list` asks the pinned official runtime to synchronize friend
relationships and emits only user IDs, usernames, display names, relationship
status, direction, timestamps, and incoming-request visibility. `--query` is an
exact local lookup; ambiguous names are rejected. Friend-request mutations are
not included in this read-only surface. `--easy` performs the additional
read-only one-to-one conversation lookup and emits only send-ready
`recipientId`, `conversationId`, and optional names for mutual friends with a
resolved conversation. It requires the login-time messaging session state.

## Verification

```powershell
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Live verification requires a current browser-issued session and managed
recipient. Automatic token and heartbeat renewal use direct HTTP plus the
pinned official attestation runtime; they do not read a Brave profile or
automate a browser. A rejected renewal stops safely; the CLI does not fall back
to browser automation.

`debug auth-gap` is limited to one explicitly enabled, read-only request against
the allowlisted MessagingCoreService `DeltaSync`/`GetGroups` paths or the
observed DeltaForce `DeltaSync` path. It emits only sanitized status and
request metadata; it does not retry or print credentials. Its `--session`
argument must resolve to `SNAP_SESSION_FILE`, and that export must match the
configured account and build.

`debug auth-renewal --cli-only` is also opt-in and read-only. It requires
`SNAP_LIVE_TESTS=1`, attempts at most one CLI-only token renewal, an hourly
heartbeat when due, and one
read-only verification request, and never persists refreshed session state from
this diagnostic path. The protected verification fixture must be named
`edge-delta-probe.json`, live
beside `SNAP_SESSION_FILE`, and carry a `binding` object whose `accountId`,
`buildId`, and `sessionExportedAt` exactly match that configured session. A
legacy unbound fixture or a stale/different account, build, or session epoch is
rejected before refresh or verification network traffic.

The command returns only sanitized result metadata:

- `renewed`: that one diagnostic execution completed a local refresh and the
  single read-only verification request succeeded.
- `browser-context-required`: the refresh or verification path reached a
  browser-bound redirect/forbidden outcome such as HTTP `303` or `403`.
- `rejected`: the local refresh path ran, but the single verification request
  still did not succeed.

The command does not print or persist raw Cookie, Bearer, token, proof, or
request/response body material.

`debug gateway-handshake --json` is an explicitly enabled, read-only WebSocket
Upgrade probe. It reports only the HTTP status, selected protocol category,
response header names, timing, and a safe classification. A `401` or `403`
means the shared token was rejected in the CLI's Gateway connection context;
the CLI does not attempt a browser-context bypass.

debug auth-binding har and debug auth-binding classify are offline sanitized
diagnostics. The HAR command accepts only files inside the configured private
directory and returns counts, fixed-safe metadata, protocol labels, and body
length/hash; it never emits credentials. The probe and gateway variants
require SNAP_LIVE_TESTS=1, perform at most one allowlisted read-only operation,
and return only a bounded observation. They do not automate login, extract
browser keys, or modify Chat/Snap/Gateway production paths.

See [session export format](docs/session-export-format.md),
[security boundaries](docs/security-boundaries.md), and the
[build update runbook](docs/build-update-runbook.md).

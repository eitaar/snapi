# Snapchat private Web API CLI

Experimental Node.js/TypeScript CLI for one operator-controlled Snapchat Web
session. It executes the pinned Snapchat JavaScript/WASM runtime to create
protected message envelopes. The current supported Web build is only
`8dd50222`.

This uses an undocumented private API. Snapchat can change the bundle,
authentication, protocol, or account policy at any time. Use only managed test
accounts and conversations you control. The project does not automate login,
2FA, account recovery, or rate-limit bypass. During token refresh it can run
the official Web Attestation WASM inside a Node worker, but it never extracts
or spoofs browser-managed session keys.

## Requirements and setup

- Node.js 24 or newer
- A session export from an already logged-in Snapchat Web session (for account,
  build, and runtime state)
- The exact four pinned assets under `private/assets/`
- Windows with the matching Brave profile available; close Brave before
  automatic refresh so its encrypted Cookie and DBSC SQLite stores are
  readable

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

The CLI finds Brave's default profile automatically under `%LOCALAPPDATA%`.
Set `SNAP_BRAVE_PROFILE_DIR` to the profile's `Default` directory when using a
different Brave user profile. During refresh the CLI reads legacy v10/v11
Snapchat Cookie values from that profile and performs DBSC signing from the same
profile. Current Brave profiles may use v20 App-Bound cookies; those require the
Brave browser context and are reported as `AUTH_CONTEXT_UNAVAILABLE` by the
direct CLI.
When either manual Cookie override is set, the refresh path uses the configured
header and skips Brave's local Cookie/DBSC readers for that refresh. This is a
diagnostic override, not a durable authentication mechanism.

## Commands

```powershell
node dist/cli/index.js session check
node dist/cli/index.js session import private/fresh-session.json
node dist/cli/index.js session refresh-har private/fresh.har
node dist/cli/index.js chat send <recipient-uuid> "test message" --conversation-id <conversation-uuid>
node dist/cli/index.js chat watch --json
node dist/cli/index.js snap send <recipient-uuid> photo.png --conversation-id <conversation-uuid>
node dist/cli/index.js snap watch --output-dir .snap-incoming --json
node dist/cli/index.js friends list --json
node dist/cli/index.js friends list --query <username-or-user-id> --json
node dist/cli/index.js gateway status
node dist/cli/index.js debug doctor --runtime
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-renewal --cli-only
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-gap --request private/edge-delta-probe.json --session private/session.json --mode node-web-cookie --auth-epoch edge-capture-1
```

`session check` performs shape, account, lock, asset hash, module, and WASM
checks without authenticated network traffic. `session refresh-har` extracts
only the accounts-domain SSO request from a fresh sensitive HAR, immediately
refreshes the short-lived token, and atomically persists the rotated state.
`session import` validates the export and every declared asset hash while
holding the account's single-writer lock, then atomically installs it.

Chat and photo commands acquire a single-writer account lock, verify the pinned
build before network access, initialize the official runtime, send once, and
persist updated cryptographic state. Photo input is limited to validated JPEG
or PNG files up to 10 MiB. Media is AES-encrypted before the signed Snap CDN
upload; signed URLs and key material are never emitted.

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
not included in this read-only surface.

## Verification

```powershell
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Live verification requires an already logged-in matching Brave profile and
managed recipient. An expired export first reads compatible Brave cookies, then
runs standalone Web Attestation and, on Windows, the matching Brave DBSC proof
path. If the profile is unavailable/locked, uses v20 App-Bound cookies, or
belongs to another authentication epoch, refresh stops with
`AUTH_CONTEXT_UNAVAILABLE`; the CLI does not fall back to browser automation or
claim that a copied Cookie is sufficient unless a manual Cookie override is
configured. A copied Cookie can test whether local App-Bound decryption is the
only blocker, but it does not guarantee that Node requests have the browser's
full context.

`debug auth-gap` is limited to one explicitly enabled, read-only request against
the allowlisted MessagingCoreService `DeltaSync`/`GetGroups` paths or the
observed DeltaForce `DeltaSync` path. It emits only sanitized status and
request metadata; it does not retry or print credentials.

`debug auth-renewal --cli-only` is also opt-in and read-only. It requires
`SNAP_LIVE_TESTS=1`, attempts at most one CLI-only SSO/DBSC renewal plus one
read-only verification request, and never persists refreshed session state from
this diagnostic path. It returns only sanitized result metadata:

- `renewed`: that one diagnostic execution completed a local refresh and the
  single read-only verification request succeeded.
- `browser-context-required`: the refresh or verification path reached a
  browser-bound redirect/forbidden outcome such as HTTP `303` or `403`.
- `profile-unavailable`: the local Brave/DBSC profile material needed for the
  CLI-only path was unavailable in the current host context.
- `rejected`: the local refresh path ran, but the single verification request
  still did not succeed.

The command does not print or persist raw Cookie, Bearer, token, proof, or
request/response body material.

See [session export format](docs/session-export-format.md),
[security boundaries](docs/security-boundaries.md), and the
[build update runbook](docs/build-update-runbook.md).

# CLI Login, Renewal, and Reliable Send Design

## Status

Approved in chat on 2026-08-13 for specification. This document still requires user review before implementation planning.

## Goal

Make the pinned Snapchat Web CLI build `8dd50222` usable without HAR after an initial interactive CLI login, and establish live-confirmed support for PNG Photo Snap and text Chat sending. Preserve the existing rule that ambiguous sends are never retried.

## Scope

This design adds:

- `session login`, with masked username/password entry and conditional OTP entry;
- a CLI-owned Cookie jar and durable login/session state;
- startup catch-up renewal plus long-running token and Web-session renewal;
- live verification for PNG Photo Snap and text Chat sending;
- bounded shutdown so a confirmed send exits successfully.

This design does not add:

- CAPTCHA solving or bypass;
- automated device approval, account recovery, or unknown challenge handling;
- password persistence;
- automatic resend after an ambiguous result;
- support for an unpinned Snapchat Web build;
- a promise that a server-revoked session can be renewed forever.

## Current Evidence

The local login HAR for the managed account shows this sequence without exposing credential values:

1. `POST /accounts/sso` redirects to `/v2/login`.
2. The login application loads from `accounts.snapchat.com` and pinned static assets.
3. `POST /snap.security.WebAttestationService/BootstrapAttestationSession` establishes the observed Web attestation session.
4. `POST /snapchat.janus.api.WebLoginService/WebLogin` is used repeatedly across credential and OTP stages.
5. Successful login establishes accounts-domain authentication cookies, including host-scoped auth and nonce cookies.
6. `GET /accounts/sso` redirects to `/web`, then `POST /accounts/sso` returns the shared Messaging/Gateway token.
7. `POST /web-chat-session/refresh` succeeds with the shared Bearer token and Web Cookie.

The existing CLI has already confirmed a JPEG native Photo Snap through:

`getUploadLocations -> encrypted CDN PUT -> CreateContentMessage`.

That success additionally requires:

- Web Cookie plus Bearer on Snapchat Web gRPC-Web requests;
- the case-sensitive lower-camel method `getUploadLocations`;
- merged exports for colliding Worker/main Webpack modules in the pinned build.

## Architecture

### 1. Interactive login state machine

`session login` owns a strict state machine:

```text
bootstrap
  -> credentials-required
  -> otp-required (optional)
  -> authenticated
  -> web-session-established
  -> messaging-state-initialized
  -> persisted
```

The command reads username and password through an injected terminal prompt abstraction. Password and OTP input are masked where the host terminal permits it. Password and OTP values exist only in command-local memory, are not returned from the login client, are never added to an error object, and are cleared from mutable buffers after use.

The login client uses a scoped Cookie jar for `accounts.snapchat.com`, `web.snapchat.com`, and the observed Snapchat session service. It follows redirects only to an explicit Snapchat-origin allowlist and applies normal Cookie domain, path, Secure, expiry, and deletion semantics. It never forwards accounts-domain cookies to the Web or CDN origins.

The pinned official accounts login JavaScript/protobuf contract is treated as build-specific input, like the existing messaging runtime. The implementation must extract and verify the exact login assets and module signatures from the observed build before making an authenticated request. It must not guess protobuf field meanings from captured secret payloads.

`WebLogin` responses are mapped to these public states only:

- credentials accepted;
- OTP required;
- authenticated;
- invalid credentials;
- rate limited;
- CAPTCHA required;
- device approval required;
- unsupported challenge.

CAPTCHA, device approval, and unsupported challenges terminate without additional requests. The CLI reports the challenge category, never the challenge payload.

### 2. Session construction after login

An SSO token alone is insufficient. After authentication, the command must:

1. obtain the shared Messaging/Gateway token through the observed SSO flow;
2. establish the Web session heartbeat;
3. load and verify the four pinned messaging assets;
4. initialize the official messaging runtime with a fresh local/session/IndexedDB state;
5. create or import the login-time messaging key initialization state;
6. export the root wrapping key and durable official runtime state;
7. perform one read-only friend sync as the authorization gate;
8. atomically persist the complete session only after every prior step succeeds.

Failure before the atomic write leaves the previous session untouched. A first login with no previous session writes a new session only after the read-only gate succeeds.

### 3. Secret storage

The password and OTP are never persisted.

Bearer tokens, Cookie jars, nonce/CSRF state, and messaging key state are encrypted at rest using Windows DPAPI for the current user. The session file becomes a non-secret metadata envelope containing account/build identifiers, timestamps, asset records, and a reference to the encrypted payload. Existing plaintext format-version-1 sessions are supported only for one-way migration after validation; migration writes the encrypted form atomically and leaves a recoverable backup until the new form is verified.

The decrypted payload is held only for the lifetime of a command or long-running client. Logging and error serialization continue to redact authentication, Cookie, signed URL, key, message, recipient, and conversation values.

### 4. Renewal lifecycle

The renewal coordinator is shared by Messaging, media upload, friends, and Gateway.

For every command startup it:

1. loads and decrypts the current session;
2. checks token and heartbeat timestamps;
3. performs overdue SSO renewal first;
4. performs an overdue Web heartbeat second;
5. atomically persists each successful Cookie/token rotation before publishing it to clients;
6. pushes the same auth epoch into the official Worker and Gateway provider.

For long-running commands it schedules renewal before the observed ten-minute token age and one-hour Web heartbeat age. One in-flight refresh is shared across callers. Transient network and 5xx failures use capped exponential backoff with jitter; 401, 403, redirects to login, invalid token responses, and unsupported challenges stop renewal and mark the session as login-required. The coordinator never retries a message send as part of renewal.

This makes operation HAR-free after a successful CLI login while the server continues accepting the login context. Server revocation, CAPTCHA, device approval, policy changes, or a new build require another interactive `session login`.

### 5. PNG Photo Snap

The existing validated PNG path remains the implementation path:

- verify PNG signature, IHDR, dimensions, extension, and 10 MiB limit;
- pass `image/png` to the official runtime;
- obtain one upload location with Cookie plus Bearer;
- encrypt and upload once;
- call `CreateContentMessage` once with a client message ID;
- persist crypto state before reporting confirmation.

The live acceptance test sends one generated, non-sensitive PNG to the configured managed test recipient. A confirmed server response establishes support. `DELIVERY_UNCONFIRMED`, timeout after final send, or any ambiguous response is reported and never retried.

### 6. Text Chat

The existing text path remains the implementation path:

- validate non-empty UTF-8 text up to 16,384 bytes;
- optionally send typing notification only if its failure cannot block the message;
- create the protected content with the official runtime;
- call `CreateContentMessage` once with a client message ID;
- persist crypto state before reporting confirmation.

The live acceptance test sends one deterministic, harmless test message to the configured managed test recipient. The same no-retry rule applies to ambiguous outcomes.

### 7. Shutdown semantics

Once `CreateContentMessage` is confirmed and crypto state is persisted, cleanup failure must not convert the send into a failed delivery result.

`ContentRuntimeClient.shutdown()` receives a short graceful deadline. On expiry it terminates the Worker and returns a cleanup warning to the caller instead of a delivery error. CLI commands print success only after confirmed send and state persistence, then emit a sanitized warning if forced termination was required. A confirmed send exits with code `0`; an ambiguous send keeps the existing distinct nonzero exit code.

## Component Boundaries

- `auth/login-*`: prompt-independent login state machine, official login contract adapter, challenge classification.
- `auth/cookie-jar`: scoped RFC-style Cookie storage and `Set-Cookie` application.
- `session/sealed-*`: DPAPI encryption, metadata envelope, migration, atomic persistence.
- `auth/renewal-coordinator`: startup catch-up, timers, single-flight refresh, backoff, login-required state.
- `runtime/official-*`: pinned official JS/WASM execution and messaging state export.
- `transport/*`: Cookie/Bearer propagation restricted by origin and request kind.
- `cli/commands/session-login`: masked terminal interaction and final atomic install.
- existing media/messaging clients: one-shot send semantics and state persistence.

No component receives the password except the login state machine, and no network component can request an arbitrary origin.

## Error Model

New public error outcomes:

- `LOGIN_INVALID_CREDENTIALS` — credentials rejected without retry;
- `LOGIN_OTP_REQUIRED` — only for non-interactive invocation;
- `LOGIN_CHALLENGE_REQUIRED` — CAPTCHA, device approval, or unsupported challenge category;
- `LOGIN_RATE_LIMITED` — includes only a safe retry delay when supplied;
- `SESSION_LOGIN_REQUIRED` — stored context can no longer renew;
- `SESSION_SECRET_UNAVAILABLE` — DPAPI payload cannot be decrypted by the current Windows user;
- `CLEANUP_FORCED` — warning-only after a confirmed operation.

Errors must not contain raw response bodies, protobuf payloads, credentials, cookies, tokens, nonce values, signed URLs, IDs, message text, or image bytes.

## Verification

### Offline gates

- State-machine tests for password, OTP, invalid credentials, rate limit, CAPTCHA, device approval, and unknown challenge.
- Cookie-jar tests for origin/domain/path/Secure/expiry/deletion and cross-origin non-forwarding.
- Golden contract tests against sanitized login request/response fixtures from the pinned build.
- DPAPI adapter tests with an injected protector plus Windows integration smoke tests that never print plaintext.
- Atomic migration/recovery tests for legacy session files.
- Renewal fake-clock tests covering startup catch-up, shared refresh, timer ordering, rotation persistence, backoff, and login-required terminal state.
- PNG and Chat send tests covering exact RPC names, Cookie plus Bearer, one attempt, persistence-before-success, and ambiguous no-retry behavior.
- Shutdown tests proving confirmed delivery remains exit `0` after forced Worker termination.
- Full serial test suite, typecheck, build, and `git diff --check`.

### Live gates

Live tests require explicit `SNAP_LIVE_TESTS=1`, the configured managed account, and one user-authorized execution per mutating case.

1. Interactive CLI login with password and, when requested, OTP.
2. Process restart followed by read-only friend sync without HAR.
3. Forced startup renewal after advancing/overriding the freshness threshold, followed by read-only friend sync.
4. One PNG Photo Snap to the configured test recipient.
5. One text Chat to the configured test recipient.
6. Confirmed send exits `0`, including when graceful Worker shutdown is deliberately forced to time out in a controlled test.

No live mutating test is automatically repeated. If delivery is ambiguous, testing stops.

## Success Criteria

- `session login` completes without browser automation and persists no password or OTP.
- A new process can use the stored session without HAR.
- Renewal keeps one long-running process authorized across at least two token-renewal intervals and one Web-heartbeat interval, or reports the exact server-side login-required boundary.
- PNG Photo Snap and text Chat each receive one confirmed live server response.
- Confirmed sends exit `0` even if Worker cleanup requires forced termination.
- CAPTCHA, device approval, unknown challenge, revoked context, and build mismatch fail closed.

## Build and Protocol Change Policy

All login and messaging contracts remain pinned to build `8dd50222`. Any asset hash, module signature, response enum, protobuf shape, endpoint, or redirect-policy mismatch returns `UNSUPPORTED_BUILD` before credential submission or authenticated mutation. Supporting a new build requires new sanitized fixtures, signatures, and live acceptance gates.

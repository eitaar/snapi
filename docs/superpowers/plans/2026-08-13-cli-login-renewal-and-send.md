# CLI Login, Renewal, and Reliable Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved CLI-only login flow, HAR-free session renewal, PNG/Chat send verification hooks, and successful-send cleanup semantics for pinned build `8dd50222`.

**Architecture:** Keep the existing official JS/WASM Worker as the only content-crypto implementation. Add a scoped authentication layer around it: CookieJar for origin-safe cookies, a renewal coordinator shared by `AuthProvider`, Worker, Gateway, and gRPC, and a DPAPI-backed session payload store. The login command uses a prompt-independent state machine and a pinned WebLogin transport; it persists state only after SSO, heartbeat, runtime initialization, and read-only friend synchronization succeed.

**Tech Stack:** Node.js 24, strict TypeScript/NodeNext ESM, `node:worker_threads`, `node:sqlite`, Windows PowerShell/.NET DPAPI/CNG bridges, Fetch, WebCrypto, fake-indexeddb, Vitest, pinned Snapchat Web build `8dd50222`.

**Spec:** `docs/superpowers/specs/2026-08-13-cli-login-renewal-and-send-design.md`

## Global Constraints

- Use only the managed operator-owned account and configured test conversation.
- Never print or persist passwords, OTPs, raw Cookies, Bearer tokens, signed URLs, private keys, message bodies, image bytes, or raw protobuf payloads.
- Do not solve or bypass CAPTCHA, device approval, account recovery, rate limits, DBSC, or browser security controls.
- Keep all authenticated origins explicit: `accounts.snapchat.com`, `web.snapchat.com`, and `session.snapchat.com`; CDN upload URLs are used only after official server issuance.
- Build-specific login and messaging contracts must fail closed with `UNSUPPORTED_BUILD` when asset signatures or response shapes differ.
- Never retry a Chat or Snap send after a post-send authentication, timeout, or ambiguous transport result.
- Every implementation task follows TDD: write the focused failing test, run it red, implement the smallest fix, then run it green.

## File Map

- Create `src/auth/cookie-jar.ts` and `tests/auth/cookie-jar.test.ts` for scoped Cookie storage and `Set-Cookie` application.
- Create `src/session/sealed-store.ts` and `tests/session/sealed-store.test.ts` for DPAPI payload protection and legacy migration helpers.
- Create `src/auth/login-state.ts`, `src/auth/login-wire.ts`, `src/auth/login-client.ts`, and matching tests for the login state machine and pinned WebLogin transport.
- Create `src/cli/terminal.ts` and `src/cli/commands/session-login.ts`, with command tests, for masked interactive input and safe challenge output.
- Modify `src/session/loader.ts`, `src/session/state-store.ts`, `src/session/types.ts`, and `src/session/schema.ts` to support sealed payload resolution without breaking validated legacy imports.
- Modify `src/transport/auth-provider.ts`, `src/transport/sso-auth-refresh.ts`, and `src/client.ts` for shared renewal state, bounded backoff, and login-required propagation.
- Modify `src/runtime/worker-client.ts`, `src/client.ts`, `src/cli/commands/chat-send.ts`, and `src/cli/commands/snap-send.ts` for bounded cleanup after confirmed delivery.
- Modify `src/cli/index.ts`, `src/errors.ts`, `README.md`, and the session/security docs for public command/error behavior.

### Task 1: Make confirmed sends exit successfully after cleanup timeout

**Files:**
- Modify: `src/runtime/worker-client.ts`
- Modify: `src/client.ts`
- Modify: `src/cli/commands/chat-send.ts`
- Modify: `src/cli/commands/snap-send.ts`
- Test: `tests/runtime/worker-client.test.ts`
- Test: `tests/cli/commands.test.ts`

**Interfaces:**
- Add `shutdownTimeoutMs?: number` to `ContentRuntimeClientOptions`.
- `ContentRuntimeClient.shutdown(): Promise<void>` must terminate the Worker after the grace deadline and not reject solely because graceful shutdown timed out.
- `SnapchatClient.close()` remains `Promise<void>` and must preserve a confirmed send result when cleanup is forced.

- [ ] **Step 1: Write the failing shutdown-timeout test**

Add a Worker fixture whose `shutdown` response never arrives, construct `ContentRuntimeClient` with `shutdownTimeoutMs: 25`, call `shutdown()`, and assert it resolves and the Worker is terminated.

- [ ] **Step 2: Run the focused test and verify the expected timeout failure**

Run `npm test -- --maxWorkers=1 tests/runtime/worker-client.test.ts`. It must fail because shutdown currently uses the normal request timeout and rejects.

- [ ] **Step 3: Implement bounded shutdown**

Split the internal request timeout from the shutdown timeout. On shutdown deadline, mark the client closed, reject any remaining pending request with the existing runtime error, call `worker.terminate()`, and resolve the public shutdown method. Do not change send retry or delivery classification.

- [ ] **Step 4: Add command-level cleanup regression coverage**

Use a fake configured client that returns `{ status: "confirmed" }` and rejects only from `close()`. Assert `runChatSend` and `runSnapSend` retain exit code `0` after confirmed delivery.

- [ ] **Step 5: Run focused tests, typecheck, and build**

Run `npm test -- --maxWorkers=1 tests/runtime/worker-client.test.ts tests/cli/commands.test.ts`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 6: Commit**

Commit with `fix: keep confirmed sends successful after worker cleanup timeout`.

### Task 2: Add origin-safe CookieJar and shared renewal state

**Files:**
- Create: `src/auth/cookie-jar.ts`
- Modify: `src/transport/auth-provider.ts`
- Modify: `src/transport/sso-auth-refresh.ts`
- Modify: `src/client.ts`
- Test: `tests/auth/cookie-jar.test.ts`
- Test: `tests/transport/auth-provider.test.ts`
- Test: `tests/transport/sso-auth-refresh.test.ts`

**Interfaces:**
- `CookieJar.setFromResponse(origin: string, response: Response): void` applies only valid `Set-Cookie` attributes.
- `CookieJar.headerFor(url: string | URL): string` returns cookies matching origin, domain, path, Secure, and expiry.
- `CookieJar.mergeHeader(origin: string, cookieHeader: string): void` imports a known request Cookie header without copying it across origins.
- `AuthProvider` exposes `renewalState(): { status: "ready" | "renewing" | "login-required"; lastFailure?: string }` with safe failure categories only.

- [ ] **Step 1: Write failing CookieJar tests**

Cover host-only cookies, domain cookies, path filtering, Secure filtering, `Max-Age=0` deletion, expiry, duplicate-name replacement, and proof that an accounts cookie is absent from a Web or CDN request.

- [ ] **Step 2: Run the tests red**

Run `npm test -- --maxWorkers=1 tests/auth/cookie-jar.test.ts`; the module must be missing.

- [ ] **Step 3: Implement CookieJar**

Parse only standard `Set-Cookie` attributes, reject malformed names/values, preserve insertion order for deterministic headers, and make `headerFor` origin/path aware. Do not expose a method that returns all cookies.

- [ ] **Step 4: Write renewal failure/backoff tests**

Use fake timers to assert one in-flight refresh, capped exponential retry after network/5xx failure, terminal `login-required` on 303/403/invalid-token, and propagation of a successful auth epoch to the runtime persistence callback before the next request.

- [ ] **Step 5: Implement renewal state and startup catch-up**

Extend `AuthProvider` with single-flight renewal status, bounded backoff with jitter injection, and a terminal safe state. Keep the existing ten-minute token and one-hour heartbeat thresholds. Successful persistence must precede `current` publication and Worker update.

- [ ] **Step 6: Integrate CookieJar into refresh responses**

Replace ad-hoc cookie merging in SSO/Web heartbeat refresh with origin-scoped jar operations while preserving the current public `SessionExport.auth.cookieHeader` and `ssoCookieHeader` fields.

- [ ] **Step 7: Run focused tests, typecheck, and build**

Run the CookieJar, AuthProvider, and SSO refresh tests, then `npm run typecheck` and `npm run build`.

- [ ] **Step 8: Commit**

Commit with `feat: add scoped cookies and resilient session renewal`.

### Task 3: Seal session secrets with Windows DPAPI and support migration

**Files:**
- Create: `src/session/sealed-store.ts`
- Modify: `src/session/loader.ts`
- Modify: `src/session/state-store.ts`
- Modify: `src/session/types.ts`
- Modify: `src/session/schema.ts`
- Modify: `src/errors.ts`
- Test: `tests/session/sealed-store.test.ts`
- Test: `tests/session/loader.test.ts`
- Test: `tests/session/state-store.test.ts`

**Interfaces:**
- `SessionSecretProtector.protect(value: Uint8Array): Promise<Uint8Array>` and `.unprotect(value: Uint8Array): Promise<Uint8Array>`.
- `SealedSessionStore.read(path: string): Promise<SessionExport>` and `.write(path: string, session: SessionExport): Promise<void>`.
- `loadSession(path)` must accept the new sealed envelope and validated legacy format-1 files.

- [ ] **Step 1: Write failing protector and envelope tests**

Use an injected deterministic protector to assert the disk envelope contains no token/Cookie sentinel, decrypts to the original validated session, rejects tampering, and preserves atomic previous-file recovery.

- [ ] **Step 2: Run the tests red**

Run `npm test -- --maxWorkers=1 tests/session/sealed-store.test.ts`; the module must be missing.

- [ ] **Step 3: Implement the injected protector boundary**

Define the binary envelope with version, algorithm label, nonce/metadata, and protected payload. Authenticate the envelope before parsing JSON. Keep protected bytes out of logs and error details.

- [ ] **Step 4: Implement Windows DPAPI adapter**

Use a hidden `powershell.exe -NoLogo -NoProfile -NonInteractive` process with an encoded script calling Windows DPAPI for current-user protection. Map unavailable Windows/DPAPI failures to `SESSION_SECRET_UNAVAILABLE` without exposing plaintext.

- [ ] **Step 5: Integrate sealed reads/writes and one-way legacy migration**

Load the new envelope first. For legacy format-1 input, validate it fully, use it in memory, and write the sealed form only when the caller performs an explicit state write. Preserve `.previous` recovery through the existing atomic store.

- [ ] **Step 6: Run focused tests, typecheck, and build**

Run sealed-store, loader, and state-store tests, then `npm run typecheck` and `npm run build`.

- [ ] **Step 7: Commit**

Commit with `feat: protect session secrets with user-scoped storage`.

### Task 4: Implement interactive CLI login and final session construction

**Files:**
- Create: `src/auth/login-state.ts`
- Create: `src/auth/login-wire.ts`
- Create: `src/auth/login-client.ts`
- Create: `src/cli/terminal.ts`
- Create: `src/cli/commands/session-login.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/errors.ts`
- Test: `tests/auth/login-state.test.ts`
- Test: `tests/auth/login-client.test.ts`
- Test: `tests/cli/session-login.test.ts`

**Interfaces:**
- `LoginPrompt.promptUsername(): Promise<string>`
- `LoginPrompt.promptPassword(): Promise<Uint8Array>`
- `LoginPrompt.promptOtp(): Promise<Uint8Array>`
- `LoginTransport.start(): Promise<LoginSessionHandle>`
- `LoginSessionHandle.submitCredentials(username: string, password: Uint8Array): Promise<LoginStep>`
- `LoginSessionHandle.submitOtp(otp: Uint8Array): Promise<LoginStep>`
- `LoginStep` is one of `{ kind: "authenticated", session: LoginSessionSeed }`, `{ kind: "otp-required" }`, `{ kind: "invalid-credentials" }`, `{ kind: "rate-limited", retryAfterMs?: number }`, `{ kind: "challenge", challenge: "captcha" | "device-approval" | "unsupported" }`.

- [ ] **Step 1: Write failing state-machine tests**

Cover direct authentication, one OTP transition, invalid credentials, rate limit, CAPTCHA, device approval, unsupported challenge, missing OTP in non-interactive mode, and clearing password/OTP buffers after each transition.

- [ ] **Step 2: Run the state tests red**

Run `npm test -- --maxWorkers=1 tests/auth/login-state.test.ts`; the module must be missing.

- [ ] **Step 3: Implement login-state.ts**

Implement a pure transition loop around `LoginPrompt` and `LoginTransport`. It may submit credentials once and OTP once per invocation; it must stop on any challenge category and return only safe `AppError` details.

- [ ] **Step 4: Write sanitized WebLogin wire-contract tests**

Use captured metadata and manually redacted gRPC-Web fixtures to assert method path, allowed headers, frame handling, and response classification. Do not commit raw HAR bodies, credentials, Cookies, or tokens.

- [ ] **Step 5: Implement login-wire.ts and login-client.ts**

Use the pinned Web Attestation runtime for the attestation bootstrap, a scoped CookieJar for accounts/session origins, and the observed `WebLogin` gRPC-Web endpoint. The adapter must verify the expected build/module signature before sending credentials and return `UNSUPPORTED_BUILD` if the contract is not present. It must not follow redirects outside the explicit Snapchat allowlist.

- [ ] **Step 6: Implement session-login command**

Prompt for credentials, run the login state machine, perform SSO token exchange and Web heartbeat, initialize the official messaging runtime, export crypto state, run one read-only friend sync, and write the sealed session atomically only after the gate succeeds. Never write password or OTP.

- [ ] **Step 7: Register command and safe error mapping**

Add `session login` to `src/cli/index.ts`, map login errors to stable exit codes, and print only state/challenge/retry metadata.

- [ ] **Step 8: Run focused tests, typecheck, and build**

Run login-state, login-client, and session-login tests, then `npm run typecheck` and `npm run build`.

- [ ] **Step 9: Commit**

Commit with `feat: add interactive CLI login without password persistence`.

### Task 5: Verify PNG/Chat paths and document operational commands

**Files:**
- Modify: `README.md`
- Modify: `docs/session-export-format.md`
- Modify: `docs/security-boundaries.md`
- Test: `tests/cli/commands.test.ts`
- Test: `tests/media/client.test.ts`
- Test: `tests/messaging/client.test.ts`

**Interfaces:**
- Preserve `snap send <recipient-id> <image> --conversation-id <conversation-id>`.
- Preserve `chat send <recipient-id> <text> --conversation-id <conversation-id>`.
- Add documented `session login` and `session status` behavior without exposing secrets.

- [ ] **Step 1: Add/strengthen offline PNG and Chat assertions**

Assert PNG MIME/dimensions, lower-camel `getUploadLocations`, Cookie plus Bearer request headers, one `CreateContentMessage`, state persistence before confirmation, and ambiguous-send no-retry for both media and text.

- [ ] **Step 2: Run the focused tests red for any missing assertion**

Run the media, messaging, transport, and CLI command tests and correct only implementation defects revealed by the assertions.

- [ ] **Step 3: Update operational documentation**

Document `session login`, non-persistent masked credentials, renewal behavior, CAPTCHA/device-approval stop conditions, PNG/Chat commands, and the confirmed-send/no-retry rule.

- [ ] **Step 4: Run the complete offline verification gate**

Run `npm test -- --maxWorkers=1`, `npm run typecheck`, `npm run build`, and `git diff --check`.

- [ ] **Step 5: Commit**

Commit with `docs: document CLI login and send verification`.

### Live verification after all offline tasks

- [ ] Run `node dist/cli/index.js session check` without mutating network state.
- [ ] With explicit `SNAP_LIVE_TESTS=1`, run `session login` interactively only when the user is present to enter credentials/OTP.
- [ ] Restart the process and run `friends list --json` without a HAR.
- [ ] Run one user-authorized PNG Snap test and stop on any ambiguous result.
- [ ] Run one user-authorized text Chat test and stop on any ambiguous result.
- [ ] Record only exit code and sanitized status; never print credential or payload material.

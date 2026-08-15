# Gateway Connection Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `node dist/cli/index.js gateway status` establish and prove a stable direct CLI Gateway connection when the current browser-proven auth epoch permits it, and otherwise replace the generic failure with the narrowest sanitized terminal diagnosis.

**Architecture:** Start with a same-epoch causal gate before changing transport or renewal behavior. If the browser-proven token gets Node HTTP Upgrade `101`, replace the opaque global WebSocket boundary with one status-aware production handshake and verify stability. If only post-SSO state fails, preserve separate direct-HTTP and browser-proven Gateway/sync token roles. If the exact fresh browser token gets Node `401`, record an auth-context boundary and fail closed; this plan does not spoof TLS/browser identity or bypass attestation.

**Tech Stack:** Node.js 24, strict TypeScript/NodeNext ESM, existing sealed-session/auth-binding diagnostics, optional `ws` 8.18.x transport selected only after the evidence gate, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-auth-binding-investigation-design.md`; supporting evidence is in `docs/runtime-feasibility-report.md`.

## Global Constraints

- Support only pinned Snapchat Web build `8dd50222`.
- Use only the configured operator-controlled account.
- Never send Chat, Snap, typing, read, open, replay, screenshot, or any write-side event during diagnosis or verification.
- Never print or commit Cookie, Bearer, Gateway token, token hash/prefix/suffix, attestation, raw frame, response body, TLS secret, DBSC key, or App-Bound key material.
- Live output may contain only status, fixed classification, protocol category, allowlisted header names, duration, close code, and equality booleans.
- Use one Node Gateway attempt per fresh auth epoch. Do not automatically retry `401`, `403`, or `429`.
- Stop immediately on `429`, login challenge, account warning, unexpected write endpoint, or mismatched auth epoch.
- Do not alter TLS ciphers, ALPN, certificate validation, QUIC, browser security controls, browser fingerprints, or header ordering to imitate Brave.
- Do not automate login, OTP, CAPTCHA, device approval, Brave startup, or credential extraction.
- Preserve the unrelated untracked plan `docs/superpowers/plans/2026-08-13-chat-receive-gateway-auth-recovery.md` unchanged.
- Production Chat/Snap send paths remain unchanged.

---

### Task 1: Establish the current same-epoch truth gate

**Files:**
- Read only: `private/<fresh-gateway-epoch>.har`
- Use: `src/diagnostics/auth-binding-har.ts`
- Use: `src/diagnostics/auth-binding-probe.ts`
- Use: `src/cli/commands/debug-auth-binding.ts`
- Append sanitized result only: `docs/runtime-feasibility-report.md`

**Interfaces:**
- Consumes: one newly exported HAR containing Browser Gateway `101`, selected `snap-ws-auth`, and a successful allowlisted Messaging read from the same login epoch.
- Produces: one sanitized Node Gateway observation with `tokenEqualsEpochBaseline: true` or a pre-network baseline rejection.

- [ ] **Step 1: Capture a clean Browser baseline**

Clear DevTools Network entries, reload the logged-in Brave page normally, wait for Gateway `101` plus one natural read-only Messaging sync, and export `private/gateway-natural.har`. Do not manually send or open content during this capture.

- [ ] **Step 2: Validate and import the baseline offline**

Run:

```powershell
node dist/cli/index.js debug auth-binding har --file private/gateway-natural.har --epoch gateway-natural-1
node dist/cli/index.js session refresh-har private/gateway-natural.har
node dist/cli/index.js session check
```

Required summary: build `8dd50222`, at least one Gateway `101`, selected protocol `snap-ws-auth`, at least one read-only Messaging `200`, and Gateway/Messaging token equality `true`. Stop if the capture contains a write-path red flag created during this capture.

- [ ] **Step 3: Run exactly one same-epoch Node Upgrade probe**

Run:

```powershell
$env:SNAP_LIVE_TESTS="1"
node dist/cli/index.js debug auth-binding gateway --baseline-har private/gateway-natural.har --mode node-gateway --epoch gateway-natural-1
```

Do not run `gateway status` in this epoch after the probe.

- [ ] **Step 4: Apply the exact decision table**

| Result | Meaning | Next task |
|---|---|---|
| pre-network baseline mismatch | session/HAR epoch mismatch | obtain one new HAR; do not call the server |
| `101`, `snap-ws-auth` | direct Node Upgrade auth is accepted | Task 2 |
| `401` with baseline equality true | exact browser-proven token is rejected outside Browser | Task 4; skip transport/token-split fixes |
| `403` | browser-managed auth context or account policy required | Task 4; stop live work |
| `429` | rate limit | stop all live work |
| TLS/timeout/connection | failure occurred before HTTP classification | Task 2 diagnostics only; do not change auth |

- [ ] **Step 5: Append the sanitized result**

Record epoch label, operation, status/classification, protocol, duration, and equality booleans. Do not record identifiers, token age precise enough to identify a session, or raw headers.

Commit:

```powershell
git add docs/runtime-feasibility-report.md
git commit -m "docs: record fresh gateway auth boundary"
```

### Task 2: Replace the opaque WebSocket boundary after direct Upgrade is viable

**Gate:** Execute the full task only if Task 1 returned Node `101`. If Task 1 returned a transport/TLS/timeout category, implement Steps 1-4 only to preserve the precise category, then rerun one fresh epoch before proceeding.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/gateway/transport-events.ts`
- Create: `src/gateway/ws-transport.ts`
- Modify: `src/gateway/client.ts`
- Create: `tests/gateway/ws-transport.test.ts`
- Modify: `tests/gateway/client.test.ts`

**Interfaces:**
- Consumes: fixed Gateway URL, `Origin: https://www.snapchat.com`, protocols `['snap-ws-auth', gatewayToken]`, and optional Web Cookie.
- Produces: `createNodeGatewaySocket(...): GatewaySocket` plus bounded failure metadata from the same production handshake.

- [ ] **Step 1: Define the safe transport event type in a failing test**

Use this exact type:

```ts
export interface GatewayTransportFailure {
  readonly phase:
    | "socket-construction"
    | "upgrade"
    | "transport"
    | "protocol-selection"
    | "closed-before-ready";
  readonly classification:
    | "authorization-rejected"
    | "rate-limited"
    | "connection"
    | "tls"
    | "timeout"
    | "unexpected-status";
  readonly status?: number;
  readonly responseHeaderNames?: readonly string[];
  readonly errorName?: string;
}
```

Write tests for synchronous construction failure, rejected HTTP `401`/`403`/`429`, TLS code, timeout, wrong selected protocol, and close before open. Assert sentinel credentials never occur in serialized errors.

- [ ] **Step 2: Run focused tests and verify red**

```powershell
npx vitest run tests/gateway/client.test.ts tests/gateway/ws-transport.test.ts --maxWorkers=1
```

Expected: FAIL because the existing global WebSocket path collapses pre-open errors to `GATEWAY_DISCONNECTED`.

- [ ] **Step 3: Install the status-aware transport**

```powershell
npm install ws@^8.18.3
npm install --save-dev @types/ws
```

`ws` is used because its client emits `unexpected-response` with the rejected HTTP status and supports explicit protocols/custom Origin. Do not install proxy, TLS, impersonation, redirect, or header-order packages.

- [ ] **Step 4: Implement one real handshake, not a preflight**

Construct:

```ts
new WebSocket(url, protocols, {
  followRedirects: false,
  handshakeTimeout: 10_000,
  headers: { Origin: "https://www.snapchat.com", ...optionalCookie },
});
```

Listen to `unexpected-response`, record only status and allowlisted header names, do not read the body, destroy the response/request, and settle once. Map error codes to `tls`, `timeout`, or `connection`. Set `binaryType = "arraybuffer"`. Preserve dependency injection for unit tests.

- [ ] **Step 5: Prevent pre-open reconnect loops**

`GatewayClient` must schedule reconnect only after a socket reached `open` and later closed abnormally. Construction, upgrade, TLS, timeout, protocol-selection, and close-before-ready failures reject once and leave no reconnect timer.

- [ ] **Step 6: Run tests and commit**

```powershell
npx vitest run tests/gateway/ws-transport.test.ts tests/gateway/client.test.ts --maxWorkers=1
npm run typecheck
npm run build
git diff --check
```

Expected: PASS.

```powershell
git add package.json package-lock.json src/gateway/transport-events.ts src/gateway/ws-transport.ts src/gateway/client.ts tests/gateway/ws-transport.test.ts tests/gateway/client.test.ts
git commit -m "fix: expose gateway upgrade failures"
```

### Task 3: Preserve split token roles only if renewal causes the regression

**Gate:** Execute only when a fresh imported token opens Gateway, then a standard SSO renewal changes the persisted token and the new state gets `401`, while the still-current browser-proven captured token succeeds in an in-memory probe. Do not execute when the exact fresh captured token already gets `401` in Task 1.

**Files:**
- Modify: `src/transport/sso-auth-refresh.ts`
- Modify: `tests/transport/sso-auth-refresh.test.ts`
- Modify: `tests/transport/auth-provider.test.ts`
- Modify: `docs/session-export-format.md`

**Interfaces:**
- Consumes: `httpToken`, `gatewayToken`, `tokenRefreshedAt`, and `gatewayTokenCapturedAt`.
- Produces: SSO renewal that rotates direct HTTP auth without overwriting the last browser-proven Gateway token.

- [ ] **Step 1: Write the failing lifecycle tests**

Assert:

```ts
expect(refreshed.auth.httpToken).toBe(NEW_SSO_HTTP_TOKEN);
expect(refreshed.auth.gatewayToken).toBe(CAPTURED_GATEWAY_TOKEN);
expect(refreshed.auth.gatewayTokenCapturedAt).toBe(CAPTURED_AT);
```

- [ ] **Step 2: Run tests and verify red**

```powershell
npx vitest run tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts --maxWorkers=1
```

Expected: FAIL because current SSO renewal replaces both tokens.

- [ ] **Step 3: Implement the minimal split**

In `refreshSnapchatSso`, update `httpToken`, `tokenRefreshedAt`, and accounts-domain Cookie only. Do not assign `gatewayToken` or `gatewayTokenCapturedAt`. HAR import remains the only path that replaces the browser-proven Gateway token. Document this Gateway-only lifetime rule without changing official Messaging synchronization in this plan.

- [ ] **Step 4: Run tests and commit**

```powershell
npx vitest run tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts --maxWorkers=1
npm run typecheck
git diff --check
```

Expected: PASS.

```powershell
git add src/transport/sso-auth-refresh.ts tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts docs/session-export-format.md
git commit -m "fix: preserve browser-proven gateway auth"
```

### Task 4: Fail closed on a proven browser auth-context boundary

**Gate:** Execute when Task 1 returns `401`/`403` for the exact same fresh token that produced Browser Gateway `101`.

**Files:**
- Modify: `src/gateway/client.ts`
- Modify: `src/cli/gateway-status-client.ts`
- Modify: `src/cli/commands/gateway-status.ts`
- Modify: `tests/gateway/client.test.ts`
- Create: `tests/cli/gateway-status-client.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `GatewayTransportFailure` or sanitized `GatewayHandshakeObservation` with `authorization-rejected`.
- Produces: `AUTH_CONTEXT_UNAVAILABLE` with fixed safe metadata and zero retries.

- [ ] **Step 1: Write failing terminal-boundary tests**

For `401` and `403`, assert:

```ts
expect(error).toMatchObject({
  code: "AUTH_CONTEXT_UNAVAILABLE",
  details: { phase: "upgrade", status: 401 },
});
expect(socketFactory).toHaveBeenCalledOnce();
expect(refresh).not.toHaveBeenCalled();
```

For `429`, require `RATE_LIMITED`. Verify no reconnect timer and no secret-bearing error fields.

- [ ] **Step 2: Implement exact error mapping**

Map production `401`/`403` to `AUTH_CONTEXT_UNAVAILABLE` with phase and status only. Token equality remains evidence from Task 1's baseline-bound diagnostic and must not be inferred inside `gateway status`. When Task 1 proved equality, document that the browser-proven Gateway token was rejected outside the browser context and that the CLI cannot safely manufacture the missing context. Do not suggest TLS spoofing, DBSC key extraction, attestation bypass, or repeated HAR replay.

- [ ] **Step 3: Document the terminal result**

Document that offline tests can validate the CLI but cannot prove live connectivity, and that this result means direct standalone Gateway is not established for the tested auth epoch.

- [ ] **Step 4: Run tests and commit**

```powershell
npx vitest run tests/gateway/client.test.ts tests/cli/gateway-status-client.test.ts tests/cli/commands.test.ts --maxWorkers=1
npm run typecheck
git diff --check
```

Expected: PASS.

```powershell
git add src/gateway/client.ts src/cli/gateway-status-client.ts src/cli/commands/gateway-status.ts tests/gateway/client.test.ts tests/cli/gateway-status-client.test.ts README.md
git commit -m "fix: classify browser-bound gateway rejection"
```

### Task 5: Prove a stable open connection after Upgrade succeeds

**Gate:** Execute only after Task 1 returned `101` and Task 2's status-aware production socket reaches `open`.

**Files:**
- Modify: `src/gateway/client.ts`
- Modify: `src/cli/commands/gateway-status.ts`
- Modify: `src/cli/gateway-status-client.ts`
- Modify: `tests/gateway/client.test.ts`
- Modify: `tests/cli/commands.test.ts`
- Use offline only: `scripts/analyze-gateway-har.mjs`

**Interfaces:**
- Produces: `waitForStableOpen(durationMs: number): Promise<GatewayConnectionStatus>`.

Define:

```ts
export interface GatewayConnectionStatus {
  readonly status: "open";
  readonly stableForMs: number;
}
```

- [ ] **Step 1: Write failing stability tests**

With fake timers, verify the same socket remaining open for `1_000` ms resolves. A socket closed or replaced during the interval must reject with only `{ phase: "post-open-close", code }`; never include close reason.

- [ ] **Step 2: Implement passive stability waiting**

Track an active connection generation. The method resolves only if that generation remains open for the full interval. Clear timers on resolve, reject, replacement, and shutdown. Do not send ping, application payload, subscription, or heartbeat frames.

- [ ] **Step 3: Compare Browser frame direction only if stability fails**

Run the existing analyzer offline:

```powershell
node scripts/analyze-gateway-har.mjs private/gateway-natural.har
```

Inspect only direction, opcode, lengths, gRPC frame kind, and Gateway path labels. If Browser sends a client frame before receiving the first server frame, record its safe descriptor and stop for a separate reviewed protocol plan; do not replay unknown payloads in this plan.

- [ ] **Step 4: Update status output and tests**

Successful JSON output:

```json
{"type":"gateway.status","status":"open","stableForMs":1000}
```

Human output: `Gateway status: open (stable 1000 ms)`.

- [ ] **Step 5: Run tests and commit**

```powershell
npx vitest run tests/gateway/client.test.ts tests/cli/commands.test.ts --maxWorkers=1
npm run typecheck
git diff --check
```

Expected: PASS.

```powershell
git add src/gateway/client.ts src/cli/commands/gateway-status.ts src/cli/gateway-status-client.ts tests/gateway/client.test.ts tests/cli/commands.test.ts
git commit -m "fix: require stable gateway status"
```

### Task 6: Run the final offline and single-attempt live gate

**Files:**
- Modify if behavior changed: `README.md`
- Append sanitized evidence: `docs/runtime-feasibility-report.md`

**Interfaces:**
- Consumes: the branch selected by Tasks 1-5.
- Produces: verified stable `open` or a precise terminal auth-context classification.

- [ ] **Step 1: Run the complete offline gate**

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run build
git diff --check
git fsck --full --no-reflogs
```

Expected: tests/typecheck/build/diff pass; Git has no broken refs or invalid objects. Existing dangling objects are informational and must not be deleted.

- [ ] **Step 2: Audit write and secret boundaries**

```powershell
rg -n "Authorization|Cookie|gatewayToken|httpToken|CreateContentMessage|SendTypingNotification" src/gateway src/cli tests/gateway tests/cli
```

Inspect every match. Internal field names are allowed; real values, derived identifiers, response bodies, and new calls to write-side RPCs are not.

- [ ] **Step 3: Use a new epoch for one production verification**

Export and import one new clean Browser baseline as in Task 1, then run only:

```powershell
$env:SNAP_OUTPUT="json"
node dist/cli/index.js gateway status
```

Do not manually retry in that epoch. Do not run Chat/Snap send as a connectivity test.

- [ ] **Step 4: Record the exact outcome**

- Stable `open`: record direct CLI Gateway as working for that epoch.
- `AUTH_CONTEXT_UNAVAILABLE`: record that direct standalone Gateway remains blocked by a browser auth-context boundary; do not claim transport success.
- `RATE_LIMITED`: stop live work.
- TLS/timeout/connection: record the category and investigate environment without changing authentication identity.

- [ ] **Step 5: Commit documentation if changed**

```powershell
git add README.md docs/runtime-feasibility-report.md
git commit -m "docs: record gateway recovery outcome"
```

## Completion Criteria

- The generic `GATEWAY_DISCONNECTED` is replaced by the actual sanitized failure phase/status when connection fails before open.
- A same-epoch Node `101` leads to one production WebSocket handshake and a 1,000 ms stable-open result.
- Token-role splitting is implemented only if a controlled before/after SSO comparison proves renewal caused the regression.
- A same-epoch Node `401`/`403` produces `AUTH_CONTEXT_UNAVAILABLE` with zero retries and no bypass attempt.
- `429` stops immediately.
- No Chat/Snap/write operation is used in live verification.
- No credential, credential-derived value, raw frame, response body, or browser/TLS secret appears in output or Git.
- Full serial tests, typecheck, build, diff check, and Git integrity check pass.

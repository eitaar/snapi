# Chat Receive and Gateway Authentication Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `chat watch` and `gateway status` by preserving the browser-proven login-epoch token for official feed synchronization and Gateway, while allowing SSO renewal to rotate only the direct HTTP token.

**Architecture:** Treat the browser-captured token as two credentials that start with the same value but have different lifetimes after SSO renewal. `httpToken` is rotated by `accounts/sso` and remains the credential for direct gRPC-Web sends/uploads; `gatewayToken` remains the last token proven by a successful browser Gateway `101` and is used by Gateway plus the official messaging runtime's read-only sync requests. A rejected captured token fails closed with a fresh-HAR requirement rather than retrying sends or looping SSO renewal.

**Tech Stack:** Node.js 24, strict TypeScript/NodeNext ESM, `node:worker_threads`, Fetch, WebSocket, Windows DPAPI-sealed session state, Vitest, pinned Snapchat Web build `8dd50222`.

**Spec:** `docs/superpowers/specs/2026-08-13-cli-login-renewal-and-send-design.md`, corrected by the live evidence recorded below.

## Global Constraints

- Support only pinned build `8dd50222`.
- Use only the configured operator-controlled account and read-only live probes until the final user-driven receive check.
- Never print Cookie, Bearer, Gateway token, attestation, key material, message plaintext, or raw protobuf values in diagnostics or tests.
- Never retry Chat/Snap sends. This plan changes only read-only synchronization and Gateway authentication.
- Do not automate browser login, OTP, CAPTCHA, device approval, DBSC, or browser security-context bypasses.
- Persist every successful auth update atomically before publishing it to the Worker or Gateway.
- Every implementation task follows TDD: focused failing test, observed red result, minimal implementation, focused green result, then commit.

## Evidence and Root-Cause Boundary

- The same live session produced a confirmed `CreateContentMessage`, but `chat watch` returned `SESSION_EXPIRED` and Gateway returned `GATEWAY_DISCONNECTED`.
- The sanitized Gateway Upgrade probe returned HTTP `401`, selected `snap-ws-auth`, and classified the result as `authorization-rejected`.
- In `private/fresh6.har`, the successful Gateway `101` token equals the token used by 16 successful Messaging requests. No Cookie was present on the successful Gateway request, and its Origin was `https://www.snapchat.com`; current Gateway request construction already matches those two properties.
- The currently persisted `httpToken` and `gatewayToken` are equal to each other but differ from the successful browser-captured Gateway token. This happened because `refreshSnapchatSso()` replaces both fields.
- `OfficialWorkerClient` already keeps `httpToken` and `gatewayToken` separately, but `official-network.ts` overwrites official read-only synchronization requests with `httpToken`. This bypasses the official runtime getter that returns `gatewayToken`.
- Therefore the primary defect is credential-role collapse after SSO renewal, not missing Gateway Cookie, wrong Origin, or a globally invalid account session.

## File Map

- Use the existing `debug gateway-handshake` and `debug auth-gap` probes first to validate the split-token hypothesis without changing persisted state.
- Modify `src/transport/sso-auth-refresh.ts` and `tests/transport/sso-auth-refresh.test.ts` to rotate only `httpToken` during SSO renewal.
- Modify `src/runtime/official-worker-client.ts`, `src/runtime/official-worker-entry.ts`, `src/runtime/official-network.ts`, their fixtures, and runtime tests to route `gatewayToken` to official sync while retaining `httpToken` for direct gRPC/upload auth.
- Modify `src/gateway/handshake.ts`, `src/cli/gateway-status-client.ts`, and Gateway tests to classify a rejected captured token as re-export-required before opening the long-lived socket.
- Modify `src/messaging/client.ts`, `src/client.ts`, and messaging/client tests so official sync authorization failure gives one deterministic fresh-HAR error and never performs an ineffective SSO retry loop.
- Modify `README.md`, `docs/session-export-format.md`, `docs/security-boundaries.md`, and the existing renewal design spec to document the corrected token lifecycle.

### Task 1: Prove or reject the split-token hypothesis with read-only probes

**Files:**
- Verify only: `private/<fresh-login-epoch>.har`
- Use: `src/gateway/handshake.ts`
- Use: `src/diagnostics/read-only-auth-probe.ts`
- Use: `src/cli/commands/debug-gateway-handshake.ts`
- Use: `src/cli/commands/debug-auth-gap.ts`

**Interfaces:**
- Consumes: one fresh HAR containing a successful Messaging request and Gateway `101`, plus the configured sealed session after one successful SSO renewal.
- Produces: a safe comparison containing only status, classification, token-equality booleans, capture timestamps, and auth epoch labels.

- [ ] **Step 1: Import a fresh browser-proven epoch and establish the baseline**

```powershell
node dist/cli/index.js session refresh-har private/<fresh-login-epoch>.har
$env:SNAP_LIVE_TESTS='1'
node dist/cli/index.js debug gateway-handshake --json
```

Expected: the imported token produces Gateway `101/open`. If a just-captured successful browser token is rejected immediately by the CLI, stop this plan and investigate request-shape/TLS differences; do not implement token splitting.

- [ ] **Step 2: Establish the Messaging baseline**

Run the existing allowlisted read-only auth probe with the request fixture bound to the same fresh session epoch:

```powershell
$env:SNAP_LIVE_TESTS='1'
node dist/cli/index.js debug auth-gap --request private/edge-delta-probe.json --session private/session.json --mode node-web-cookie --auth-epoch <fresh-epoch-label>
```

Expected: one read-only Messaging verification succeeds. If it fails while the browser request succeeds, stop and return to the Node/browser transport-context investigation.

- [ ] **Step 3: Let one normal SSO renewal rotate HTTP auth without importing another HAR**

Use `debug auth-renewal --cli-only` or the ten-minute watch timer, then record only these booleans and timestamps:

```text
http token changed: true
gateway token changed: current implementation true
gateway 101 after renewal: false
Messaging read-only sync after renewal: false
direct confirmed send evidence from the same epoch: already observed
```

Do not send another Chat or Snap for this diagnostic.

- [ ] **Step 4: Compare the fresh captured token without persisting it**

Use a local read-only diagnostic wrapper around `probeGatewayHandshake()` and the allowlisted auth probe. Parse the token from the HAR in memory, emit only sanitized observations, and never write or print it.

Expected decision:

```text
captured token opens Gateway and passes Messaging, rotated SSO token fails both
=> split-token hypothesis confirmed; continue to Task 2

captured token also fails
=> hypothesis rejected or capture expired; stop and obtain a new same-minute capture

both tokens pass
=> failure is not token-role collapse; stop and investigate runtime request construction
```

- [ ] **Step 5: Save only sanitized diagnostic evidence**

Do not commit the HAR or any credential. Add the safe outcome to the implementation notes or commit message only after the hypothesis is confirmed.

### Task 2: Lock the split-token lifecycle with failing tests

**Files:**
- Modify: `tests/transport/sso-auth-refresh.test.ts`
- Modify: `tests/transport/auth-provider.test.ts`

**Interfaces:**
- Consumes: `refreshSnapchatSso(session, dependencies)` and `AuthProvider.getGatewayToken()`.
- Produces: A regression contract in which SSO rotates `httpToken` but preserves `gatewayToken` and `gatewayTokenCapturedAt`.

- [ ] **Step 1: Add a failing SSO rotation test**

Add a fixture with distinct role labels and assert the exact post-refresh state:

```ts
it("rotates direct HTTP auth without replacing the browser-proven Gateway token", async () => {
  const original = session({
    httpToken: VALID_OLD_TOKEN,
    gatewayToken: VALID_CAPTURED_GATEWAY_TOKEN,
    gatewayTokenCapturedAt: "2026-08-13T10:00:00.000Z",
  });
  const refreshed = await refreshSnapchatSso(original, {
    fetch: async () => new Response(VALID_NEW_HTTP_TOKEN, { status: 200 }),
    now: () => new Date("2026-08-13T10:10:00.000Z"),
  });

  expect(refreshed.auth.httpToken).toBe(VALID_NEW_HTTP_TOKEN);
  expect(refreshed.auth.gatewayToken).toBe(VALID_CAPTURED_GATEWAY_TOKEN);
  expect(refreshed.auth.gatewayTokenCapturedAt).toBe("2026-08-13T10:00:00.000Z");
});
```

- [ ] **Step 2: Add a failing provider test**

Assert that overdue HTTP renewal occurs before `getGatewayToken()`, but the returned Gateway token remains the captured value:

```ts
await expect(provider.getGatewayToken()).resolves.toBe("captured-gateway-token");
expect(refresh).toHaveBeenCalledOnce();
expect(provider.sessionSnapshot().auth.httpToken).toBe("rotated-http-token");
```

- [ ] **Step 3: Run the focused tests and observe the intended failure**

Run:

```powershell
npx vitest run tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts
```

Expected: the new SSO test fails because `gatewayToken` currently becomes the returned SSO token.

- [ ] **Step 4: Commit only the red tests**

```powershell
git add tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts
git commit -m "test: define split messaging and gateway token renewal"
```

### Task 3: Preserve the browser-proven Gateway token during SSO renewal

**Files:**
- Modify: `src/transport/sso-auth-refresh.ts`
- Test: `tests/transport/sso-auth-refresh.test.ts`
- Test: `tests/transport/auth-provider.test.ts`

**Interfaces:**
- Consumes: Existing `SessionExport.auth.httpToken`, `gatewayToken`, `tokenRefreshedAt`, and `gatewayTokenCapturedAt`.
- Produces: `refreshSnapchatSso()` that updates HTTP auth only and leaves Gateway proof untouched.

- [ ] **Step 1: Make the minimal renewal change**

Change the successful SSO merge from updating both compatibility fields to updating only direct HTTP auth:

```ts
auth: {
  ...session.auth,
  httpToken: token,
  tokenRefreshedAt: refreshedAt,
  ssoCookieHeader: refreshedSsoCookie,
}
```

Do not assign `gatewayToken` or `gatewayTokenCapturedAt` in this function. HAR import remains the only path that replaces those fields after a successful `101` capture.

- [ ] **Step 2: Run the focused tests**

```powershell
npx vitest run tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts
```

Expected: both files pass, including existing persistence/backoff coverage.

- [ ] **Step 3: Commit the implementation**

```powershell
git add src/transport/sso-auth-refresh.ts tests/transport/sso-auth-refresh.test.ts tests/transport/auth-provider.test.ts
git commit -m "fix: preserve browser-proven gateway auth during SSO renewal"
```

### Task 4: Route the captured token through official message synchronization

**Files:**
- Modify: `src/runtime/official-worker-client.ts`
- Modify: `src/runtime/official-worker-entry.ts`
- Modify: `src/runtime/official-network.ts`
- Modify: `tests/runtime/official-network.test.ts`
- Modify: `tests/runtime/official-messaging-session.test.ts`
- Modify: `tests/fixtures/official-session-contract-worker.mjs`

**Interfaces:**
- Consumes: `RuntimeAuthUpdate.httpToken` for direct HTTP calls and `RuntimeAuthUpdate.gatewayToken` for official sync/Gateway.
- Produces: `OfficialNetworkCredentials.syncToken(): string | undefined` and host control `setOfficialSyncToken`.

- [ ] **Step 1: Add a failing network-boundary test**

Create a read-only DeltaSync request whose existing Authorization is stale and assert that the boundary uses the captured sync token:

```ts
it("uses the browser-proven sync token for official read-only requests", async () => {
  const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    expect(request.headers.get("authorization")).toBe("Bearer captured-sync-token");
    return new Response(null, { status: 200 });
  });
  const boundary = createOfficialNetworkBoundary(true, networkFetch, {
    webCookieHeader: () => "web=session",
    syncToken: () => "captured-sync-token",
  });

  await boundary.fetch(new Request(
    "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
    { method: "POST", headers: { authorization: "Bearer rotated-http-token" } },
  ));
});
```

- [ ] **Step 2: Add a failing Worker contract test**

Extend the existing distinct-token fixture so `updateAuth()` must deliver:

```ts
expect(observed).toMatchObject({
  officialSyncToken: "refreshed-official-gateway-token",
  directHttpToken: "refreshed-official-http-token",
});
```

The fixture must compare labels only and never include live credentials.

- [ ] **Step 3: Run the runtime tests and observe red**

```powershell
npx vitest run tests/runtime/official-network.test.ts tests/runtime/official-messaging-session.test.ts
```

Expected: the network test sees the rotated HTTP token because the current boundary exposes only `httpToken`.

- [ ] **Step 4: Implement explicit sync-token routing**

Rename the boundary credential and host control to describe the actual role:

```ts
export interface OfficialNetworkCredentials {
  readonly webCookieHeader: () => string | undefined;
  readonly ssoCookieHeader?: () => string | undefined;
  readonly syncToken?: () => string | undefined;
}
```

In `OfficialWorkerClient.applyUpdatedAuth()` send `auth.gatewayToken` through `__host.setOfficialSyncToken`; retain `requestAuthState.httpToken` for direct upload/gRPC auth and the WASM load callback. In `official-worker-entry.ts`, store that value as `officialSyncToken`, expose it to `createOfficialNetworkBoundary`, and update the official user-store token with the same captured value.

- [ ] **Step 5: Run the focused runtime tests**

```powershell
npx vitest run tests/runtime/official-network.test.ts tests/runtime/official-messaging-session.test.ts tests/runtime/runtime-request-auth.test.ts
```

Expected: all pass and `RuntimeRequestAuth` still serves the rotated `httpToken` for photo/direct HTTP operations.

- [ ] **Step 6: Commit the routing fix**

```powershell
git add src/runtime/official-worker-client.ts src/runtime/official-worker-entry.ts src/runtime/official-network.ts tests/runtime/official-network.test.ts tests/runtime/official-messaging-session.test.ts tests/fixtures/official-session-contract-worker.mjs
git commit -m "fix: keep official sync on browser-proven auth"
```

### Task 5: Fail closed and clearly when the captured sync/Gateway token is rejected

**Files:**
- Modify: `src/messaging/client.ts`
- Modify: `src/client.ts`
- Modify: `src/gateway/handshake.ts`
- Modify: `src/cli/gateway-status-client.ts`
- Modify: `tests/messaging/client.test.ts`
- Modify: `tests/gateway/handshake.test.ts`
- Create: `tests/cli/gateway-status-client.test.ts`

**Interfaces:**
- Consumes: `AppError("SESSION_EXPIRED", ...)`, `GatewayHandshakeObservation`, and `gatewayTokenCapturedAt`.
- Produces: deterministic `SESSION_REEXPORT_REQUIRED` errors with only safe status/classification metadata.

- [ ] **Step 1: Add Chat watch failure tests**

Assert that a rejected initial sync is converted once and does not emit, persist, or retry:

```ts
deps.runtime.syncMessages.mockRejectedValueOnce(
  new AppError("SESSION_EXPIRED", "Official message synchronization was unauthorized"),
);
const iterator = new MessagingClient(deps).messages();
await expect(iterator.next()).rejects.toMatchObject({
  code: "SESSION_REEXPORT_REQUIRED",
});
expect(deps.runtime.syncMessages).toHaveBeenCalledOnce();
expect(deps.stateStore.write).not.toHaveBeenCalled();
```

- [ ] **Step 2: Add Gateway classification tests**

Inject a handshake probe returning `authorization-rejected` and assert that the status client does not construct/open the long-lived socket and returns:

```ts
expect(error).toMatchObject({
  code: "SESSION_REEXPORT_REQUIRED",
  details: { status: 401, classification: "authorization-rejected" },
});
expect(JSON.stringify(error)).not.toContain("gateway-secret");
```

Also cover `429 -> RATE_LIMITED` and `101/snap-ws-auth -> actual Gateway connect`.

- [ ] **Step 3: Run the focused tests and observe red**

```powershell
npx vitest run tests/messaging/client.test.ts tests/gateway/handshake.test.ts tests/cli/gateway-status-client.test.ts
```

Expected: Chat still exposes `SESSION_EXPIRED`, and the status factory lacks a classified preflight.

- [ ] **Step 4: Implement bounded failure mapping**

Add a small read-only sync wrapper in `MessagingClient`:

```ts
async function synchronizeMessages(runtime: MessagingRuntime): Promise<void> {
  try {
    await runtime.syncMessages();
  } catch (error) {
    if (error instanceof AppError && error.code === "SESSION_EXPIRED") {
      throw new AppError(
        "SESSION_REEXPORT_REQUIRED",
        "Browser-proven Messaging/Gateway authorization must be refreshed from a successful HAR",
      );
    }
    throw error;
  }
}
```

Use it for both `messages()` and `snaps()`. Do not call SSO renewal here because Task 1 must first prove that SSO renewal cannot replace the captured sync/Gateway credential.

Before `gateway status` opens the long-lived socket, run the existing sanitized Upgrade probe with the current Gateway token. Convert only known classifications; do not include response bodies or header values in `AppError.details`.

- [ ] **Step 5: Run the focused tests**

```powershell
npx vitest run tests/messaging/client.test.ts tests/gateway/handshake.test.ts tests/cli/gateway-status-client.test.ts tests/cli/commands.test.ts
```

Expected: all pass with one attempt per read-only operation.

- [ ] **Step 6: Commit deterministic recovery errors**

```powershell
git add src/messaging/client.ts src/client.ts src/gateway/handshake.ts src/cli/gateway-status-client.ts tests/messaging/client.test.ts tests/gateway/handshake.test.ts tests/cli/gateway-status-client.test.ts
git commit -m "fix: classify expired sync and gateway authorization"
```

### Task 6: Update documentation and reconcile the previous shared-token claim

**Files:**
- Modify: `README.md`
- Modify: `docs/session-export-format.md`
- Modify: `docs/security-boundaries.md`
- Modify: `docs/superpowers/specs/2026-08-13-cli-login-renewal-and-send-design.md`

**Interfaces:**
- Consumes: The implemented split-token behavior from Tasks 3-5.
- Produces: Operator instructions that distinguish automatic HTTP renewal from fresh-HAR Gateway/sync renewal.

- [ ] **Step 1: Replace the incorrect lifecycle text**

Document these exact rules:

```text
- HAR import proves one login-epoch token against both Messaging and Gateway.
- SSO renewal rotates direct HTTP auth only.
- The last token proven by a successful Gateway 101 remains the official sync/Gateway token.
- A 401 from that captured credential requires a fresh successful HAR; the CLI does not manufacture or bypass browser authorization.
```

- [ ] **Step 2: Add the recovery commands**

```powershell
node dist/cli/index.js session refresh-har private/fresh.har
node dist/cli/index.js session check
node dist/cli/index.js gateway status
node dist/cli/index.js chat watch --json
```

State that `Ctrl+C` stops watch and that a confirmed send must never be repeated as a connectivity test.

- [ ] **Step 3: Run documentation and type checks**

```powershell
git diff --check
npm run typecheck
npm run build
```

- [ ] **Step 4: Commit the corrected documentation**

```powershell
git add README.md docs/session-export-format.md docs/security-boundaries.md docs/superpowers/specs/2026-08-13-cli-login-renewal-and-send-design.md
git commit -m "docs: clarify HTTP and Gateway auth lifetimes"
```

### Task 7: Verify offline and then against the managed live session

**Files:**
- Verify only; no source changes unless a failing regression test identifies a defect.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: evidence that both read-only paths work before and after HTTP renewal, or an exact external blocker.

- [ ] **Step 1: Run the complete offline gate serially**

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run build
git diff --check
git fsck --full --no-reflogs
```

Expected: tests/typecheck/build/diff exit `0`; `git fsck` may list harmless dangling objects but must report no broken refs or invalid pointers.

- [ ] **Step 2: Restore a browser-proven auth epoch**

Use the newest HAR that contains both a successful Messaging request and Gateway `101`. If `private/fresh6.har` is still accepted:

```powershell
node dist/cli/index.js session refresh-har private/fresh6.har
node dist/cli/index.js session check
```

If its captured Gateway token now returns `401`, obtain one new normal browser HAR with a successful Gateway `101`; do not weaken validation or retry the rejected credential.

- [ ] **Step 3: Verify Gateway without sending**

```powershell
node dist/cli/index.js gateway status
```

Expected: `Gateway status: open` or JSON `{ "type": "gateway.status", "status": "open" }` according to output configuration.

- [ ] **Step 4: Verify Chat receive without a CLI send**

```powershell
node dist/cli/index.js chat watch --json
```

From the operator-controlled counterpart, send one new text message, observe one `chat.message`, then stop with `Ctrl+C`. Assert no `SESSION_EXPIRED`, no duplicate message ID, and no raw credentials in output.

- [ ] **Step 5: Verify the split survives an HTTP renewal window**

Keep a read-only watch process alive beyond the ten-minute HTTP renewal threshold, stop it cleanly, and run:

```powershell
node dist/cli/index.js gateway status
node dist/cli/index.js chat watch --json
```

Expected: Gateway remains `open` and Chat synchronization starts without authorization failure after `httpToken` rotation.

- [ ] **Step 6: Record the final verification commit**

If no source change was needed during live verification, do not create an empty commit. Otherwise add only the focused regression fix and commit it with:

```powershell
git commit -m "fix: complete chat receive and gateway live recovery"
```

## Acceptance Criteria

- `chat watch --json` starts, synchronizes, emits one real controlled text message, persists state before emission, and exits cleanly on `Ctrl+C`.
- `gateway status` completes with status `open` using the same browser-proven auth epoch.
- A ten-minute SSO renewal changes `httpToken` without changing `gatewayToken` or `gatewayTokenCapturedAt`.
- Official DeltaSync/feed requests and Gateway use the browser-proven token; direct Chat/Snap send and upload HTTP use the renewed HTTP token.
- A rejected captured token produces `SESSION_REEXPORT_REQUIRED` with safe metadata and no retry loop.
- The full serial suite, typecheck, build, diff check, and Git integrity check pass.

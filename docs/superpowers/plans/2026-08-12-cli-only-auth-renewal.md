# CLI-Only Authentication Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CLI renew Snapchat authentication using only Node.js, the stored session, and locally readable legacy Brave/DBSC state, without launching or controlling a browser, while failing closed when Snapchat requires browser-managed context.

**Architecture:** Keep `AuthProvider` as the single-flight renewal coordinator. Split renewal into a CLI capability pipeline that obtains the best available Cookie source, optionally performs DBSC proof signing and Web Attestation, calls the SSO endpoint, and atomically persists the resulting token/cookie state. Propagate refreshed credentials into the official Worker before retrying read-only operations; never automatically replay an ambiguous message or Snap send.

**Tech Stack:** Node.js 24, TypeScript, `node:sqlite`, Windows DPAPI/CNG through the existing PowerShell bridge, Node `fetch`, Vitest, pinned Snapchat Web assets.

## Global Constraints

- Do not launch, control, or inspect Brave through CDP, DevTools, extensions, or browser automation.
- Do not automate login, password entry, OTP, CAPTCHA, recovery, or consent flows.
- Do not bypass v20 App-Bound Cookie protection or export DBSC private keys; unsupported v20/profile states must fail closed.
- Do not print or persist raw Cookie, Bearer, DBSC wrapped key, proof, attestation, or protected payload values in logs or diagnostics.
- Use only the configured account and its existing local session/profile state.
- Refresh at most once per logical request; retry only idempotent/read-only operations after a successful refresh.
- Do not retry `chat send` or `snap send` after a post-send authentication failure; report delivery uncertainty.
- Preserve atomic session writes and account locking through `AtomicJsonStore` and `AccountLock`.
- A live probe is opt-in and read-only; normal tests must not contact Snapchat.

---

### Task 1: Establish the CLI-only renewal capability contract

**Files:**
- Create: `src/auth/renewal.ts`
- Create: `tests/auth/renewal.test.ts`
- Modify: `src/errors.ts` only if a missing safe renewal error code is required

**Interfaces:**
- Consumes: `SessionExport`, `DbscRefreshResult`, and the existing `refreshSnapchatSso` dependencies.
- Produces:

```ts
export type RenewalCapability =
  | "manual-session"
  | "legacy-brave-cookie"
  | "dbsc-profile"
  | "web-attestation"
  | "browser-context-required";

export interface RenewalObservation {
  readonly capability: RenewalCapability;
  readonly status: "available" | "used" | "rejected" | "unavailable";
  readonly httpStatus?: number;
}

export interface RenewalResult {
  readonly session: SessionExport;
  readonly observations: readonly RenewalObservation[];
}

export function classifyRenewalFailure(error: unknown): AppError;
```

- [ ] **Step 1: Write the failing tests**

Add tests proving that the classifier maps only safe metadata:

```ts
it("classifies a redirect as browser-context-required", () => {
  const error = new AppError("AUTH_CONTEXT_UNAVAILABLE", "SSO refresh requires a browser-managed authentication context", {
    status: 303,
  });
  expect(classifyRenewalFailure(error)).toMatchObject({ code: "AUTH_CONTEXT_UNAVAILABLE" });
  expect(JSON.stringify(classifyRenewalFailure(error))).not.toContain("Bearer");
});
```

Also cover DBSC profile unavailable, SSO 403, malformed token, and unknown errors. Assert that no classifier output contains cookie/token/proof strings.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- tests/auth/renewal.test.ts
```

Expected: failure because `src/auth/renewal.ts` does not exist.

- [ ] **Step 3: Implement the minimal classifier and safe observation types**

Keep the classifier limited to `AppError.code`, numeric HTTP status, and the existing safe redirect metadata. Never include the original error message when it may contain a transport or credential value.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command and expect all renewal classifier tests to pass.

- [ ] **Step 5: Commit the isolated contract**

```powershell
git add src/auth/renewal.ts tests/auth/renewal.test.ts src/errors.ts
git commit -m "feat: define safe CLI auth renewal outcomes"
```

### Task 2: Make the existing CLI refresh pipeline explicit and capability-aware

**Files:**
- Modify: `src/transport/sso-auth-refresh.ts`
- Modify: `src/auth/dbsc.ts`
- Modify: `src/auth/brave-cookies.ts`
- Modify: `src/client.ts`
- Test: `tests/transport/sso-auth-refresh.test.ts`
- Test: `tests/auth/dbsc.test.ts`
- Test: `tests/auth/brave-cookies.test.ts`

**Interfaces:**
- Consumes: `SNAP_COOKIE_HEADER`, `SNAP_SSO_COOKIE_HEADER`, `SNAP_BRAVE_PROFILE_DIR`, and the existing session fields.
- Produces:

```ts
export interface CliRenewalOptions {
  readonly profileDir?: string;
  readonly allowLegacyBraveCookies: boolean;
  readonly allowDbsc: boolean;
  readonly allowWebAttestation: boolean;
}

export function refreshSnapchatSso(
  session: SessionExport,
  dependencies?: SsoRefreshDependencies,
): Promise<SessionExport>;
```

- [ ] **Step 1: Write failing tests for source selection and fail-closed behavior**

Add cases proving:

```ts
it("uses an explicit SSO Cookie source before a profile source", async () => {
  // supply both sources and assert only the explicit source is called
});

it("does not treat a 303 or 403 as a successful refresh", async () => {
  // return a redirect/403 response and assert AUTH_CONTEXT_UNAVAILABLE
});

it("does not attempt v20 decryption", async () => {
  // supply an unsupported app-bound cookie marker and assert a safe unavailable error
});
```

The tests must inspect call order and safe status only, never token or cookie values.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npm test -- tests/transport/sso-auth-refresh.test.ts tests/auth/dbsc.test.ts tests/auth/brave-cookies.test.ts
```

Expected: the new capability-selection assertions fail before implementation.

- [ ] **Step 3: Implement capability selection without changing cryptographic boundaries**

Use this order:

1. Explicit session/configured Cookie override.
2. Legacy v10/v11 Cookie decryption from the configured Brave profile.
3. DBSC challenge/sign/refresh using the existing Windows CNG signer.
4. Web Attestation WASM generation.
5. SSO POST with `redirect: "manual"`.

Keep the SSO response validation strict: 2xx plus a valid token and matching `scuid` is success; 3xx, 4xx, malformed token, or account mismatch is failure. Do not write a partially refreshed session.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused command and expect all existing and new tests to pass.

- [ ] **Step 5: Commit the capability pipeline**

```powershell
git add src/transport/sso-auth-refresh.ts src/auth/dbsc.ts src/auth/brave-cookies.ts src/client.ts tests/transport/sso-auth-refresh.test.ts tests/auth/dbsc.test.ts tests/auth/brave-cookies.test.ts
git commit -m "feat: make CLI auth renewal capability-aware"
```

### Task 3: Add proactive and reactive refresh coordination for safe operations

**Files:**
- Modify: `src/transport/auth-provider.ts`
- Modify: `src/transport/grpc-client.ts`
- Modify: `src/messaging/client.ts`
- Modify: `src/media/official-upload.ts`
- Test: `tests/transport/auth-provider.test.ts`
- Test: `tests/transport/grpc-client.test.ts`
- Test: `tests/messaging/client.test.ts`
- Test: `tests/media/official-upload.test.ts`

**Interfaces:**
- Consumes: `AuthProvider.refreshOnce()` and `AuthRefreshReason`.
- Produces:

```ts
export type RequestReplayPolicy = "read-only" | "idempotent" | "ambiguous-send";

export interface UnaryCallOptions {
  readonly retryKind: "none" | "idempotent" | "message-with-client-id";
  readonly replayPolicy?: RequestReplayPolicy;
}
```

- [ ] **Step 1: Write failing tests**

Add tests proving:

- expired sessions refresh before the first read request;
- concurrent callers share one refresh Promise;
- a 401/403 causes one refresh and one retry for read-only/idempotent calls;
- a second 401 is returned without a refresh loop;
- a message/Snap send is not replayed after an ambiguous response;
- a failed refresh leaves the old in-memory session unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- tests/transport/auth-provider.test.ts tests/transport/grpc-client.test.ts tests/messaging/client.test.ts tests/media/official-upload.test.ts
```

- [ ] **Step 3: Implement the smallest coordination change**

Keep the existing `AuthProvider.refreshOnce()` single-flight behavior. Add only the policy check needed to prevent replay of non-idempotent sends. Preserve `DELIVERY_UNCONFIRMED` for ambiguous send outcomes.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same command and expect all tests to pass.

- [ ] **Step 5: Commit the request policy**

```powershell
git add src/transport/auth-provider.ts src/transport/grpc-client.ts src/messaging/client.ts src/media/official-upload.ts tests/transport/auth-provider.test.ts tests/transport/grpc-client.test.ts tests/messaging/client.test.ts tests/media/official-upload.test.ts
git commit -m "feat: coordinate safe auth refresh retries"
```

### Task 4: Propagate refreshed credentials into the official Worker

**Files:**
- Modify: `src/runtime/protocol.ts`
- Modify: `src/runtime/worker-client.ts`
- Modify: `src/runtime/worker-entry.ts`
- Modify: `src/runtime/official-worker-client.ts`
- Modify: `src/runtime/official-worker-entry.ts`
- Modify: `src/client.ts`
- Test: `tests/runtime/worker-client.test.ts`
- Test: `tests/runtime/official-messaging-session.test.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: a refreshed `SessionExport` from `AuthProvider`.
- Produces:

```ts
type RuntimeCommand =
  | { readonly method: "updateAuth"; readonly session: SessionExport }
  | /* existing commands */;

class ContentRuntimeClient {
  updateAuth(session: SessionExport): Promise<void>;
}

class OfficialWorkerClient {
  updateAuth(session: SessionExport): Promise<void>;
}
```

- [ ] **Step 1: Write the failing propagation test**

Add a fixture Worker assertion that `updateAuth` changes the effective token/cookie state used by the next read-only operation, without returning the values across the test assertion boundary. Add a client-level test that a refreshed session is passed to the runtime before a friend-list retry.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- tests/runtime/worker-client.test.ts tests/runtime/official-messaging-session.test.ts tests/client.test.ts
```

- [ ] **Step 3: Implement the host-controlled update**

The Worker host must update only in-memory `webCookieHeader`, `ssoCookieHeader`, and `officialHttpToken`, then update the official auth store immediately before a retry. Do not serialize protected key material. The Node client must call `updateAuth` only after `AuthProvider.refreshOnce()` completes and session persistence succeeds.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command and expect all tests to pass.

- [ ] **Step 5: Commit the propagation boundary**

```powershell
git add src/runtime/protocol.ts src/runtime/worker-client.ts src/runtime/worker-entry.ts src/runtime/official-worker-client.ts src/runtime/official-worker-entry.ts src/client.ts tests/runtime/worker-client.test.ts tests/runtime/official-messaging-session.test.ts tests/client.test.ts
git commit -m "feat: propagate renewed auth into official worker"
```

### Task 5: Add the CLI-only live feasibility gate

**Files:**
- Create: `src/diagnostics/cli-auth-renewal.ts`
- Create: `tests/diagnostics/cli-auth-renewal.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/debug-doctor.ts`
- Modify: `README.md`
- Modify: `docs/runtime-feasibility-report.md`

**Interfaces:**
- Consumes: a configured session and the existing CLI renewal pipeline.
- Produces:

```ts
export interface CliAuthRenewalReport {
  readonly mode: "cli-only";
  readonly result: "renewed" | "browser-context-required" | "profile-unavailable" | "rejected";
  readonly statuses: readonly number[];
  readonly capabilities: readonly RenewalObservation[];
}

export async function runCliAuthRenewalProbe(): Promise<CliAuthRenewalReport>;
```

- [ ] **Step 1: Write failing offline tests**

Test every report result with mocked fetch responses and mocked profile/signing dependencies. Assert the report never contains a raw header, token, cookie, proof, or response body.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npm test -- tests/diagnostics/cli-auth-renewal.test.ts
```

- [ ] **Step 3: Implement a read-only diagnostic command**

Add:

```powershell
node dist/cli/index.js debug auth-renewal --cli-only
```

Require `SNAP_LIVE_TESTS=1`. Permit only the SSO/DBSC refresh probe and a single read-only verification request. On 303/403, report `browser-context-required` and stop; do not retry repeatedly or modify session state.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command and then update the docs with the exact interpretation of each result.

- [ ] **Step 5: Commit the diagnostic surface**

```powershell
git add src/diagnostics/cli-auth-renewal.ts tests/diagnostics/cli-auth-renewal.test.ts src/cli/index.ts src/cli/commands/debug-doctor.ts README.md docs/runtime-feasibility-report.md
git commit -m "feat: add CLI-only auth renewal feasibility probe"
```

### Task 6: Full verification and live decision gate

**Files:**
- Modify: `docs/security-boundaries.md` if the final capability matrix changes
- Modify: `docs/session-export-format.md` if renewal metadata is added

- [ ] **Step 1: Run the complete offline suite**

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run build
git diff --check
```

Expected: all offline tests pass; typecheck and build exit successfully; `git diff --check` has no whitespace errors.

- [ ] **Step 2: Run the CLI-only live probe once**

```powershell
$env:SNAP_LIVE_TESTS='1'
node dist/cli/index.js debug auth-renewal --cli-only
```

Do not print or save credentials. If the result is `renewed`, run only the read-only command:

```powershell
node dist/cli/index.js friends list --json
```

- [ ] **Step 3: Decide based on evidence**

If the SSO refresh returns 2xx with a matching account and the friend read succeeds, enable automatic CLI-only refresh in the normal client path. If SSO returns 303/403 or friend requests remain 401 after a successful local refresh, keep the automatic path fail-closed and document that the server requires browser-managed context for this build; do not add TLS, attestation, DBSC, or App-Bound Cookie bypasses.

- [ ] **Step 4: Commit only the verified final changes**

```powershell
git add src tests docs
git commit -m "feat: support safe CLI-only authentication renewal"
```

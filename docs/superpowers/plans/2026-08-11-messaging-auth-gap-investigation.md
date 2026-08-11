# Messaging Authorization Gap Investigation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the smallest missing condition that makes a read-only Snapchat MessagingCoreService request return HTTP 200 in Edge but HTTP 401 in Node, then either repair direct Node transport or prove that a real browser execution boundary is required.

**Architecture:** Start with the cheapest untested difference: browser-managed web cookies. Run paired, single-request probes against only `DeltaSync` or `GetGroups`, recording status and hashes rather than credentials or payloads. Only if cookies do not close the gap, move outward through request freshness, Edge execution context, HTTP/2/TLS, and browser/profile binding; stop at identification of an attestation boundary rather than attempting to bypass it.

**Tech Stack:** Node.js 24, TypeScript 6, Vitest 4, Node `fetch`/Undici, Node `http2`, Microsoft Edge with the installed browser-control extension, Snapchat's pinned Web Worker assets.

## Global Constraints

- Use only the operator-controlled test account and read-only `DeltaSync` or `GetGroups` calls.
- Do not send Chat messages or Snaps during this investigation.
- Do not bypass login, device verification, Web Attestation, rate limits, or browser security controls.
- Never print, hash-prefix, commit, or place in normal logs any Bearer token, cookie value, raw request body, raw response body, media bytes, cryptographic state, or signed URL.
- Secret inputs and raw captures remain under ignored `private/`; sanitized observations may contain only endpoint path, method, status, protocol, byte length, full SHA-256 body hash, safe header names, timestamps, and an operator-assigned auth epoch.
- Each live probe sends at most one request per declared mode; there is no automatic retry on 401, 403, 429, timeout, or ambiguous transport failure.
- A 429 or account warning stops all live probing immediately.
- Preserve the current uncommitted runtime diagnostics and feasibility report; do not overwrite or discard them.

---

## File Structure

- Create `src/diagnostics/auth-gap-types.ts`: sanitized observation and decision types.
- Create `src/diagnostics/read-only-auth-probe.ts`: allowlisted one-shot Node probe with explicit credential mode.
- Create `src/diagnostics/auth-gap-classifier.ts`: deterministic interpretation of paired results.
- Create `src/cli/commands/debug-auth-gap.ts`: operator command that loads ignored private inputs and emits sanitized JSON.
- Modify `src/cli/index.ts`: route `snap debug auth-gap` without affecting normal commands.
- Modify `src/runtime/official-network.ts`: only after a positive cookie result, inject the web cookie for the exact MessagingCoreService origin and path.
- Modify `src/runtime/official-worker-entry.ts`: hold the cookie only in Worker memory and expose a host-only setter.
- Modify `src/runtime/official-worker-client.ts`: install the cookie before official bundle initialization.
- Modify `src/runtime/official-host-control.ts`: expose the typed host setter for tests and diagnostics.
- Create `tests/diagnostics/read-only-auth-probe.test.ts`: allowlist, credential modes, one-shot behavior, and redaction tests.
- Create `tests/diagnostics/auth-gap-classifier.test.ts`: decision-table tests.
- Modify `tests/runtime/official-network-capture.test.ts`: origin-scoped cookie injection and leak-prevention tests.
- Modify `tests/integration/official-host-control.test.ts`: Worker host cookie setter coverage.
- Modify `tests/cli/commands.test.ts`: CLI routing and secret-free output coverage.
- Modify `docs/runtime-feasibility-report.md`: append only sanitized findings and the final direct-runtime decision.

### Task 1: Add a secret-safe evidence model and result classifier

**Files:**
- Create: `src/diagnostics/auth-gap-types.ts`
- Create: `src/diagnostics/auth-gap-classifier.ts`
- Test: `tests/diagnostics/auth-gap-classifier.test.ts`

**Interfaces:**
- Consumes: sanitized results from later Node and Edge probes.
- Produces: `SafeAuthGapObservation`, `AuthGapConclusion`, and `classifyAuthGap()`.

- [ ] **Step 1: Write the failing classifier tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyAuthGap } from "../../src/diagnostics/auth-gap-classifier.js";
import type { SafeAuthGapObservation } from "../../src/diagnostics/auth-gap-types.js";

const result = (
  context: SafeAuthGapObservation["context"],
  status: number,
): SafeAuthGapObservation => ({
  authEpoch: "edge-capture-1",
  context,
  endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
  method: "POST",
  startedAt: "2026-08-11T00:00:00.000Z",
  status,
  requestBodyBytes: 16,
  requestBodySha256: "a".repeat(64),
  safeHeaderNames: ["authorization", "content-type"],
});

describe("classifyAuthGap", () => {
  it("identifies a missing web cookie", () => {
    expect(classifyAuthGap([
      result("node-bearer", 401),
      result("node-web-cookie", 200),
    ])).toEqual({ kind: "web-cookie-required", directNodeStillViable: true });
  });

  it("identifies browser execution binding", () => {
    expect(classifyAuthGap([
      result("edge-page-replay", 200),
      result("node-http2", 401),
    ])).toEqual({ kind: "browser-context-required", directNodeStillViable: false });
  });

  it("does not overclaim when the browser replay also fails", () => {
    expect(classifyAuthGap([
      result("edge-original", 200),
      result("edge-page-replay", 401),
    ])).toEqual({ kind: "request-freshness-or-single-use", directNodeStillViable: undefined });
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/diagnostics/auth-gap-classifier.test.ts`

Expected: FAIL because the diagnostics modules do not exist.

- [ ] **Step 3: Implement the exact safe types and decision table**

```ts
export type ProbeContext =
  | "edge-original"
  | "edge-page-replay"
  | "edge-extension"
  | "node-bearer"
  | "node-web-cookie"
  | "node-http2";

export interface SafeAuthGapObservation {
  readonly authEpoch: string;
  readonly context: ProbeContext;
  readonly endpointPath: string;
  readonly method: "POST";
  readonly startedAt: string;
  readonly status?: number;
  readonly nextHopProtocol?: string;
  readonly requestBodyBytes: number;
  readonly requestBodySha256: string;
  readonly safeHeaderNames: readonly string[];
  readonly transportError?: "timeout" | "connection" | "tls" | "other";
}

export type AuthGapConclusion =
  | { readonly kind: "web-cookie-required"; readonly directNodeStillViable: true }
  | { readonly kind: "request-freshness-or-single-use"; readonly directNodeStillViable: undefined }
  | { readonly kind: "browser-context-required"; readonly directNodeStillViable: false }
  | { readonly kind: "http2-or-tls-difference"; readonly directNodeStillViable: undefined }
  | { readonly kind: "insufficient-evidence"; readonly directNodeStillViable: undefined };
```

Implement `classifyAuthGap(observations)` as an explicit ordered decision table matching the tests. It must compare only observations with the same `authEpoch`, endpoint path, body length, and full body hash; otherwise return `insufficient-evidence`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/diagnostics/auth-gap-classifier.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the evidence model**

```powershell
git add src/diagnostics/auth-gap-types.ts src/diagnostics/auth-gap-classifier.ts tests/diagnostics/auth-gap-classifier.test.ts
git commit -m "test: define auth gap evidence model"
```

### Task 2: Build the one-shot Cookie hypothesis probe

**Files:**
- Create: `src/diagnostics/read-only-auth-probe.ts`
- Create: `src/cli/commands/debug-auth-gap.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/diagnostics/read-only-auth-probe.test.ts`
- Modify: `tests/cli/commands.test.ts`

**Interfaces:**
- Consumes: `private/edge-delta-probe.json` with `url`, `method`, `headers`, and `bodyBase64`; `private/session.json` with `auth.httpToken` and `auth.cookieHeader`.
- Produces: one `SafeAuthGapObservation` and no raw artifact.

- [ ] **Step 1: Write failing tests for endpoint restriction and credential modes**

Test these exact behaviors with sentinel secrets:

```ts
it("adds only Bearer in node-bearer mode", async () => {
  const fetch = vi.fn(async (_url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-sentinel");
    expect(headers.has("cookie")).toBe(false);
    return new Response(null, { status: 401 });
  });
  const observation = await runReadOnlyAuthProbe(fixture("node-bearer"), { fetch });
  expect(JSON.stringify(observation)).not.toContain("token-sentinel");
});

it("adds the exported web cookie only in node-web-cookie mode", async () => {
  const fetch = vi.fn(async (_url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("web-cookie=sentinel");
    return new Response(null, { status: 200 });
  });
  const observation = await runReadOnlyAuthProbe(fixture("node-web-cookie"), { fetch });
  expect(JSON.stringify(observation)).not.toContain("sentinel");
});
```

Also assert rejection before fetch for GET, non-HTTPS URLs, origins other than `https://web.snapchat.com`, and paths other than the two read-only allowlisted RPCs. Assert the injected fetch is called exactly once even for 401 and 429.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/diagnostics/read-only-auth-probe.test.ts tests/cli/commands.test.ts`

Expected: FAIL because the probe and CLI route do not exist.

- [ ] **Step 3: Implement the minimal one-shot probe**

Define this input and dependency contract:

```ts
export interface ReadOnlyAuthProbeInput {
  readonly authEpoch: string;
  readonly mode: "node-bearer" | "node-web-cookie";
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyBase64: string;
  };
  readonly auth: { readonly httpToken: string; readonly cookieHeader: string };
}

export function runReadOnlyAuthProbe(
  input: ReadOnlyAuthProbeInput,
  dependencies?: { readonly fetch?: typeof globalThis.fetch; readonly now?: () => Date },
): Promise<SafeAuthGapObservation>;
```

Copy only the known non-secret headers from `edge-delta-probe.json`, then set `authorization`. Set `cookie` only for `node-web-cookie`. Compute SHA-256 and byte length in memory, call fetch once with `redirect: "error"`, and return only the sanitized observation. Do not read or retain the response body.

- [ ] **Step 4: Add CLI routing without default live execution**

Route only this exact form:

```text
snap debug auth-gap --request private/edge-delta-probe.json --session private/session.json --mode node-web-cookie --auth-epoch edge-capture-1
```

Require `SNAP_LIVE_TESTS=1`; otherwise exit with `INVALID_CONFIG`. Print one JSON object. Never include loaded input data in errors.

- [ ] **Step 5: Run tests and static verification**

Run:

```powershell
npx vitest run tests/diagnostics/read-only-auth-probe.test.ts tests/cli/commands.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the probe**

```powershell
git add src/diagnostics src/cli/index.ts src/cli/commands/debug-auth-gap.ts tests/diagnostics tests/cli/commands.test.ts
git commit -m "feat: add safe read-only auth gap probe"
```

### Task 3: Run the decisive Cookie experiment

**Files:**
- Read only: `private/edge-delta-probe.json`
- Read only: `private/session.json`
- Append sanitized result: `docs/runtime-feasibility-report.md`

**Interfaces:**
- Consumes: a fresh Edge-successful `DeltaSync` capture and matching exported session.
- Produces: the first decisive conclusion: cookie missing, or cookie insufficient.

- [ ] **Step 1: Establish freshness without exposing values**

Confirm only that both private files exist, their modification times differ by no more than two minutes, `request.method` is POST, the endpoint is allowlisted, and `session.auth.httpToken` is non-empty. Print no values, IDs, headers, or body.

- [ ] **Step 2: Run exactly one web-cookie probe**

```powershell
$env:SNAP_LIVE_TESTS='1'
node dist/cli/index.js debug auth-gap --request private/edge-delta-probe.json --session private/session.json --mode node-web-cookie --auth-epoch edge-capture-1
```

Expected outcome A: HTTP 200. Conclude `web-cookie-required` and proceed to Task 4.

Expected outcome B: HTTP 401/403. Conclude only that Bearer plus the exported web cookie is insufficient; skip Task 4 and proceed to Task 5.

Expected outcome C: HTTP 429, account warning, or transport ambiguity. Stop live testing and record only the safe status/category.

- [ ] **Step 3: Update the feasibility report**

Append the mode, status, endpoint path, body byte length/hash, and conclusion. Do not paste request headers or credential material.

### Task 4: If Cookie succeeds, wire browser cookie semantics into the official Worker

**Files:**
- Modify: `src/runtime/official-network.ts`
- Modify: `src/runtime/official-worker-entry.ts`
- Modify: `src/runtime/official-worker-client.ts`
- Modify: `src/runtime/official-host-control.ts`
- Modify: `tests/runtime/official-network-capture.test.ts`
- Modify: `tests/integration/official-host-control.test.ts`

**Interfaces:**
- Consumes: `session.auth.cookieHeader` during `OfficialWorkerClient.initializeWasm(session)`.
- Produces: automatic Cookie injection only for the exact web MessagingCoreService allowlist.

- [ ] **Step 1: Write failing network-boundary tests**

Assert that a credentials getter causes `cookie` to be added for the two allowlisted POST paths on `https://web.snapchat.com`, but never for `accounts.snapchat.com`, arbitrary web paths, GET requests, capture-only requests, or requests that already contain a Cookie header. Assert observation serialization contains no cookie value.

- [ ] **Step 2: Write a failing Worker host-control test**

Call `setOfficialWebCookie(client, "cookie-sentinel")`, assert the host path and RAW argument encoding are correct, and assert no returned or observed value includes the sentinel.

- [ ] **Step 3: Implement in-memory, origin-scoped cookie injection**

Extend `createOfficialNetworkBoundary` with:

```ts
export interface OfficialNetworkCredentials {
  readonly webCookieHeader: () => string | undefined;
}
```

Before the real network call, construct a new `Request` only for an allowlisted POST to `https://web.snapchat.com`; set Cookie if absent. Keep the cookie in a closure and never add it to `CapturedOfficialRequest` or `ObservedOfficialRequest`.

In `official-worker-entry.ts`, decode only a single `{ type: "RAW", value: string }` argument for `setWebCookieHeader`, store it in a module-local variable, and return boolean success. In `OfficialWorkerClient.initializeWasm`, set the cookie before calling `setAuthTokenGetter` or `loadWasm`.

- [ ] **Step 4: Run focused and full tests**

```powershell
npx vitest run tests/runtime/official-network-capture.test.ts tests/integration/official-host-control.test.ts
npm test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 5: Rerun the managed runtime gate once**

Run `snap debug doctor --runtime` with a freshly captured session. Expected: `DeltaSync`/`GetGroups` reaches HTTP 200 and `content_envelope_created` advances beyond the former 401. Do not send a message.

- [ ] **Step 6: Commit the direct transport repair**

```powershell
git add src/runtime tests/runtime/official-network-capture.test.ts tests/integration/official-host-control.test.ts docs/runtime-feasibility-report.md
git commit -m "fix: supply web cookies to official messaging transport"
```

### Task 5: If Cookie fails, separate freshness from browser-context binding

**Files:**
- No tracked source changes required for the first pass.
- Append sanitized results: `docs/runtime-feasibility-report.md`

**Interfaces:**
- Consumes: one fresh successful Edge read-only request retained inside Edge memory.
- Produces: paired `edge-original` and `edge-page-replay` safe observations with the same auth epoch and body hash.

- [ ] **Step 1: Connect only to the logged-in Edge tab**

Use the installed Edge browser-control extension and select the existing `https://www.snapchat.com/web` tab. Do not inspect the browser cookie store, Local Storage, password store, or profile files through browser control.

- [ ] **Step 2: Capture and replay inside the page/Worker context**

Observe the next naturally generated read-only `DeltaSync` or `GetGroups` request. Clone it before consumption, let the original finish, then replay the clone once from the same execution context. Return only the two statuses, path, body length/hash, safe header names, and `PerformanceResourceTiming.nextHopProtocol` when available.

- [ ] **Step 3: Apply the freshness decision**

- Original 200 + same-context replay 401 means the body or an embedded value is one-time/freshness-bound. Compare protobuf field positions and lengths between two successful originals using byte-offset hashes; do not persist raw bodies outside `private/`.
- Original 200 + same-context replay 200 means the request is reusable and the missing condition is outside the application payload. Proceed to Task 6.
- Any message-creating RPC means abort the replay; only the read-only allowlist may execute.

- [ ] **Step 4: Record only the sanitized conclusion**

Append `request-freshness-or-single-use` or `replayable-in-edge` to the feasibility report.

### Task 6: If the request is replayable in Edge, distinguish browser principal from protocol stack

**Files:**
- Modify: `src/diagnostics/read-only-auth-probe.ts`
- Modify: `src/diagnostics/auth-gap-classifier.ts`
- Modify: `tests/diagnostics/read-only-auth-probe.test.ts`
- Modify: `tests/diagnostics/auth-gap-classifier.test.ts`
- Append sanitized results: `docs/runtime-feasibility-report.md`

**Interfaces:**
- Consumes: the same fresh, replayable read-only request.
- Produces: `node-http2` observation and final direct-Node viability decision.

- [ ] **Step 1: Add a failing test for a single HTTP/2 request**

Inject a fake `http2.connect`, assert `:method`, `:path`, `:scheme`, `:authority`, Authorization, the exported web Cookie, and safe headers are sent once; assert pseudo-headers and secret values never appear in the returned observation.

- [ ] **Step 2: Implement `node-http2` mode**

Use `node:http2.connect("https://web.snapchat.com")`, set a 10-second timeout, disable retries, close the session in `finally`, and classify TLS/connection errors without retaining messages. Do not modify TLS options, cipher lists, ALPN negotiation, or certificate validation.

- [ ] **Step 3: Run tests**

```powershell
npx vitest run tests/diagnostics
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run one fresh `node-http2` probe**

Use the same auth epoch/body hash as the successful Edge replay.

- HTTP/2 200 means the missing condition was Node fetch/HTTP protocol behavior; replace only the affected read-only/direct transport with a tested HTTP/2 implementation.
- HTTP/2 401 while Edge replay is 200 means the requirement is bound to Edge/browser/profile execution context. Mark direct Node transport infeasible for this build.
- TLS/connection failure is inconclusive; do not label it an authentication result.

- [ ] **Step 5: Commit the protocol probe**

```powershell
git add src/diagnostics tests/diagnostics docs/runtime-feasibility-report.md
git commit -m "test: isolate browser transport authorization gap"
```

### Task 7: Produce the final evidence-backed architecture decision

**Files:**
- Modify: `docs/runtime-feasibility-report.md`
- Modify only if the design changes: `README.md`

**Interfaces:**
- Consumes: classifier output and sanitized observations.
- Produces: one of three actionable outcomes.

- [ ] **Step 1: State the narrowest supported conclusion**

Use exactly one outcome:

1. `Direct Node viable: web cookie was missing.` Include the regression test and successful managed runtime gate.
2. `Direct Node viable only with HTTP/2 transport.` Include the Edge/Node fetch/Node HTTP2 status matrix.
3. `Real browser context required.` Include the Edge same-context 200 versus Node-with-cookie-and-HTTP2 401 matrix, and state that the exact server-side signal remains opaque.

- [ ] **Step 2: Apply the stop boundary**

If outcome 3 is reached, do not attempt to spoof TLS fingerprints, extract device-bound keys, patch attestation code, or automate account verification. Propose a browser bridge in which the logged-in Edge context performs network transport while the CLI retains orchestration and sanitized output.

- [ ] **Step 3: Run the full non-live release gate and secret scan**

```powershell
npm run typecheck
npm test
npm run test:coverage
npm run build
git status --short
```

Search tracked source, tests, and docs for the current private secret values without printing them; expected match count is zero. Confirm `private/`, HARs, build output, coverage output, and raw probe artifacts remain ignored.

- [ ] **Step 4: Commit only the final report or design change**

```powershell
git add docs/runtime-feasibility-report.md README.md
git commit -m "docs: record messaging authorization boundary"
```

## Decision Order

```text
Bearer + exported web Cookie in Node
  -> 200: missing item found; inject Cookie safely and rerun official Worker gate
  -> 401: replay same fresh read-only request inside Edge
       -> 401: request is freshness/single-use bound; compare successful originals
       -> 200: run one standards-compliant Node HTTP/2 probe
            -> 200: Node fetch/protocol mismatch
            -> 401: real Edge/browser/profile context is required
```

## Completion Criteria

- The conclusion is supported by at least one paired experiment using the same auth epoch, endpoint, body length, and full body hash.
- A Cookie result is not inferred from header inspection; it is demonstrated by a 401-to-200 change with only web Cookie inclusion changed.
- Browser binding is not claimed until same-context Edge replay succeeds and both Node-with-cookie and Node-HTTP/2 fail with 401.
- No live message or Snap was sent, no retries occurred, and no secret appeared in tracked files or normal logs.
- The feasibility report states both what was proved and what remains unknown.

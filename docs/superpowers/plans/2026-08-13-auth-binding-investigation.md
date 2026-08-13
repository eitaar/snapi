# Snapchat Web Auth Binding Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secret-safe diagnostic workflow that identifies whether build `8dd50222` binds read-only Messaging and Gateway authorization to token freshness, a connection instance, HTTP/3/QUIC, TLS/client implementation, browser process/profile, browser principal, or bootstrap sequence.

**Architecture:** Keep production Chat/Snap send code unchanged and add a separate diagnostics layer. The layer parses HAR metadata, runs one-shot allowlisted Node probes, accepts sanitized browser/.NET observations, and applies a deterministic classifier to comparable observations from the same auth epoch. Live browser comparisons remain operator-driven; the CLI never automates login, OTP, CAPTCHA, browser security controls, or credential extraction.

**Tech Stack:** Node.js 24, strict TypeScript/NodeNext ESM, Node `https`/`http2`/WebSocket, PowerShell/.NET 9 for one external HTTP/3 probe, Vitest, existing sealed-session loader, existing HAR parser conventions.

**Spec:** `docs/superpowers/specs/2026-08-13-auth-binding-investigation-design.md`

## Global Constraints

- Support only pinned build `8dd50222`.
- Use only the operator-controlled account and read-only Messaging `DeltaSync`, `BatchDeltaSync`, `GetGroups`, and Gateway handshake operations.
- Never send Chat, Snap, typing notifications, read receipts, open/replay notifications, or friend mutations during this investigation.
- Each live mode sends at most one request per declared auth epoch; no automatic retry on `401`, `403`, `429`, timeout, or ambiguous transport failure.
- A `429`, account warning, login challenge, unexpected write path, or send RPC stops live probing immediately.
- Never print, hash-prefix, commit, or persist in tracked files any Bearer token, Cookie, Gateway token, attestation, key material, raw protobuf, raw request/response body, media bytes, signed URL, TLS key log, QUIC secret, DBSC key, or App-Bound Cookie key.
- Sanitized observations may contain only context labels, endpoint paths, operation labels, timestamps, statuses, protocol labels, safe header names, request byte length, full request-body SHA-256, token-equality booleans, connection/process/route equality booleans, and bounded error categories.
- Preserve the existing untracked `docs/superpowers/plans/2026-08-13-chat-receive-gateway-auth-recovery.md`; do not overwrite or delete it.
- Do not add a production dependency for HTTP/3 during this investigation. The .NET probe is an external diagnostic command and its output is sanitized before ingestion.
- All new source behavior follows TDD: failing focused test, observed red result, minimal implementation, focused green result, then commit.

## File Map

- Create `src/diagnostics/auth-binding-types.ts`: safe contexts, observations, baseline metadata, and final conclusion types.
- Create `src/diagnostics/auth-binding-classifier.ts`: deterministic comparison and classification logic.
- Create `src/diagnostics/auth-binding-har.ts`: metadata-only HAR parser for successful Gateway and Messaging baselines.
- Create `src/diagnostics/auth-binding-probe.ts`: one-shot Node HTTP/1.1, Node HTTP/2, and Gateway probe adapters.
- Create `src/cli/commands/debug-auth-binding.ts`: `debug auth-binding` subcommands for HAR summary, Node probes, observation validation, and classification.
- Modify `src/cli/index.ts`: route `debug auth-binding` without affecting normal commands.
- Create `scripts/probe-auth-binding-http3.ps1`: one-shot .NET 9 HTTP/3 read-only probe that emits only sanitized JSON.
- Create `tests/diagnostics/auth-binding-classifier.test.ts`: decision-table and comparability tests.
- Create `tests/diagnostics/auth-binding-har.test.ts`: safe HAR metadata extraction and secret-redaction tests.
- Create `tests/diagnostics/auth-binding-probe.test.ts`: one-shot Node transport and Gateway adapter tests.
- Modify `tests/cli/commands.test.ts`: route, validation, and secret-free output tests.
- Create `tests/fixtures/auth-binding-observations.json`: sanitized labels/statuses only; no credential-shaped values.
- Modify `docs/runtime-feasibility-report.md`: append the sanitized live results and final boundary decision.

### Task 1: Define the safe evidence model and classifier

**Files:**
- Create: `src/diagnostics/auth-binding-types.ts`
- Create: `src/diagnostics/auth-binding-classifier.ts`
- Create: `tests/diagnostics/auth-binding-classifier.test.ts`

**Interfaces:**
- Consumes: sanitized observations with no credential material.
- Produces: `SafeAuthBindingObservation`, `AuthBindingConclusion`, and `classifyAuthBinding(observations)`.

- [ ] **Step 1: Write the failing classifier tests**

Add tests for these exact outcomes:

```ts
const observation = (
  context: SafeAuthBindingObservation["context"],
  operation: SafeAuthBindingObservation["operation"],
  status: number,
  protocol: SafeAuthBindingObservation["protocol"],
): SafeAuthBindingObservation => ({
  authEpoch: "epoch-a",
  context,
  operation,
  endpointPath: operation === "gateway-handshake"
    ? "/snapchat.gateway.Gateway/WebSocketConnect"
    : "/messagingcoreservice.MessagingCoreService/DeltaSync",
  startedAt: "2026-08-13T13:37:56.814Z",
  status,
  protocol,
  requestBodyBytes: operation === "messaging-read" ? 65 : undefined,
  requestBodySha256: operation === "messaging-read" ? "a".repeat(64) : undefined,
  safeHeaderNames: ["authorization", "origin"],
  tokenEqualsEpochBaseline: true,
  networkRouteEqualsBaseline: true,
});

it("classifies h3 success and h2 failure as HTTP/3 binding", () => {
  expect(classifyAuthBinding([
    observation("brave-natural", "messaging-read", 200, "h3"),
    observation("brave-h2-natural", "messaging-read", 401, "h2"),
  ])).toMatchObject({ kind: "http3-quic-bound" });
});

it("classifies Browser h2 success and Node h2 failure as TLS/client binding", () => {
  expect(classifyAuthBinding([
    observation("brave-h2-natural", "messaging-read", 200, "h2"),
    observation("node-http2", "messaging-read", 401, "h2"),
  ])).toMatchObject({ kind: "tls-client-bound" });
});

it("classifies old connection success and new connection failure only when token equality holds", () => {
  expect(classifyAuthBinding([
    { ...observation("brave-natural", "gateway-handshake", 101, "websocket"), connectionEqualsPrevious: true },
    { ...observation("brave-reload", "gateway-handshake", 401, "websocket"), connectionEqualsPrevious: false },
  ])).toMatchObject({ kind: "connection-instance-bound" });
});

it("returns insufficient evidence when epoch or body identity differs", () => {
  const first = observation("brave-natural", "messaging-read", 200, "h3");
  const second = { ...observation("node-http2", "messaging-read", 401, "h2"), authEpoch: "epoch-b" };
  expect(classifyAuthBinding([first, second])).toMatchObject({ kind: "insufficient-evidence" });
});
```

- [ ] **Step 2: Run the focused test and observe the intended failure**

Run:

```powershell
npx vitest run tests/diagnostics/auth-binding-classifier.test.ts
```

Expected: FAIL because the new types and classifier do not exist.

- [ ] **Step 3: Implement the exact safe types**

Define these types without credential fields:

```ts
export type AuthBindingContext =
  | "brave-natural"
  | "brave-reload"
  | "brave-restart"
  | "brave-h2-natural"
  | "brave-page-replay"
  | "brave-worker-replay"
  | "node-http1"
  | "node-http2"
  | "dotnet-http3"
  | "node-gateway"
  | "dotnet-gateway";

export type AuthBindingOperation = "messaging-read" | "gateway-handshake";
export type AuthBindingProtocol = "http/1.1" | "h2" | "h3" | "websocket";

export interface SafeAuthBindingObservation {
  readonly authEpoch: string;
  readonly context: AuthBindingContext;
  readonly operation: AuthBindingOperation;
  readonly endpointPath: string;
  readonly startedAt: string;
  readonly status?: number;
  readonly protocol?: AuthBindingProtocol;
  readonly requestBodyBytes?: number;
  readonly requestBodySha256?: string;
  readonly safeHeaderNames: readonly string[];
  readonly tokenEqualsEpochBaseline: boolean;
  readonly connectionEqualsPrevious?: boolean;
  readonly browserProcessEqualsPrevious?: boolean;
  readonly networkRouteEqualsBaseline?: boolean;
  readonly bootstrapStage?: string;
  readonly transportError?: "timeout" | "connection" | "tls" | "other";
}

export type AuthBindingKind =
  | "token-freshness-bound"
  | "connection-instance-bound"
  | "browser-process-or-profile-bound"
  | "http3-quic-bound"
  | "tls-client-bound"
  | "browser-principal-bound"
  | "bootstrap-sequence-bound"
  | "server-side-browser-binding"
  | "insufficient-evidence";

export interface AuthBindingConclusion {
  readonly kind: AuthBindingKind;
  readonly operation: AuthBindingOperation | "mixed";
  readonly evidenceContexts: readonly AuthBindingContext[];
  readonly reason: string;
}
```

Implement `classifyAuthBinding(observations: readonly SafeAuthBindingObservation[]): AuthBindingConclusion` with this order: reject mismatched epoch/body identity, reject observations with only transport errors, check freshness/replay, check connection equality, check browser process/profile equality, check h3 versus h2, check Browser h2 versus Node h2, check Worker versus page replay, check bootstrap stages, then return `server-side-browser-binding` only when same token/epoch/body and same route are proven but all client-visible differences are exhausted. Otherwise return `insufficient-evidence`.

- [ ] **Step 4: Run the focused tests and commit the evidence model**

Run:

```powershell
npx vitest run tests/diagnostics/auth-binding-classifier.test.ts
```

Expected: PASS. Then commit:

```powershell
git add src/diagnostics/auth-binding-types.ts src/diagnostics/auth-binding-classifier.ts tests/diagnostics/auth-binding-classifier.test.ts
git commit -m "feat: add auth binding evidence classifier"
```

### Task 2: Parse HAR baselines without exposing credentials

**Files:**
- Create: `src/diagnostics/auth-binding-har.ts`
- Create: `tests/diagnostics/auth-binding-har.test.ts`

**Interfaces:**
- Consumes: HAR JSON containing successful Gateway `101` and Messaging read-only `200` entries.
- Produces: `summarizeAuthBindingHar(input)` returning only safe baseline metadata.

- [ ] **Step 1: Write the failing parser tests**

Use an in-memory mini HAR fixture containing one Gateway `101`, one Messaging `DeltaSync 200`, one `CreateContentMessage 200`, and one cookie-bearing SSO request. Assert:

```ts
const result = summarizeAuthBindingHar(JSON.stringify(fixture));
expect(result.gateway101Count).toBe(1);
expect(result.messagingSuccessCount).toBe(1);
expect(result.messagingWriteCount).toBe(1);
expect(result.gatewayMessagingTokenEqual).toBe(true);
expect(result.gatewayOrigin).toBe("https://www.snapchat.com");
expect(result.gatewayHasCookie).toBe(false);
expect(JSON.stringify(result)).not.toContain("token-sentinel");
expect(JSON.stringify(result)).not.toContain("cookie-sentinel");
```

Also assert that a HAR without Gateway `101`, without Messaging `200`, with a write-only capture, or with mismatched Gateway/Messaging token values throws `INVALID_SESSION_EXPORT` without echoing either value.

- [ ] **Step 2: Run the parser tests and observe red**

Run:

```powershell
npx vitest run tests/diagnostics/auth-binding-har.test.ts
```

Expected: FAIL because `auth-binding-har.ts` does not exist.

- [ ] **Step 3: Implement metadata-only HAR parsing**

Define:

```ts
export interface AuthBindingHarSummary {
  readonly buildId: "8dd50222";
  readonly gateway101Count: number;
  readonly messagingSuccessCount: number;
  readonly messagingWriteCount: number;
  readonly gatewayMessagingTokenEqual: boolean;
  readonly gatewayOrigin?: string;
  readonly gatewayHasCookie: boolean;
  readonly gatewayHasAuthorization: boolean;
  readonly gatewayRequestHeaderNames: readonly string[];
  readonly messagingRequestHeaderNames: readonly string[];
  readonly gatewayProtocols: readonly string[];
  readonly messagingProtocols: readonly string[];
  readonly gatewayStartedAt?: string;
  readonly messagingStartedAt?: string;
  readonly messagingBodyBytes?: number;
  readonly messagingBodySha256?: string;
}

export function summarizeAuthBindingHar(input: string | Uint8Array): AuthBindingHarSummary;
```

Reuse the existing safe HAR conventions from `src/session/har-auth.ts` and `scripts/analyze-gateway-har.mjs`: token comparison happens in memory, body hashing uses SHA-256, and the returned object contains no token values, token hashes, Cookie values, Authorization values, signed URL, raw body, response body, or WebSocket message data. Count only allowlisted read-only Messaging paths and Gateway Upgrade; count write paths only as a red-flag count.

- [ ] **Step 4: Run tests, typecheck, and commit**

Run:

```powershell
npx vitest run tests/diagnostics/auth-binding-har.test.ts
npm run typecheck
```

Expected: PASS. Then commit:

```powershell
git add src/diagnostics/auth-binding-har.ts tests/diagnostics/auth-binding-har.test.ts
git commit -m "feat: summarize auth binding HAR metadata safely"
```

### Task 3: Add one-shot Node HTTP and Gateway probes

**Files:**
- Create: `src/diagnostics/auth-binding-probe.ts`
- Create: `tests/diagnostics/auth-binding-probe.test.ts`
- Use: `src/diagnostics/read-only-auth-probe.ts`
- Use: `src/gateway/handshake.ts`

**Interfaces:**
- Consumes: a read-only request fixture, loaded session auth, and an explicit mode.
- Produces: one `SafeAuthBindingObservation` per call, with no retry or secret output.

- [ ] **Step 1: Write failing adapter tests**

Test these exact contracts with sentinel credentials held only inside the fake transport:

```ts
const result = await runNodeAuthBindingProbe({
  authEpoch: "epoch-a",
  context: "node-http1",
  request: deltaSyncFixture,
  auth: { httpToken: "token-sentinel", cookieHeader: "cookie-sentinel" },
}, { fetch: fakeFetchReturning(401) });

expect(result).toMatchObject({
  context: "node-http1",
  operation: "messaging-read",
  status: 401,
  protocol: "http/1.1",
});
expect(JSON.stringify(result)).not.toContain("token-sentinel");
expect(JSON.stringify(result)).not.toContain("cookie-sentinel");
expect(fakeFetch).toHaveBeenCalledOnce();
```

Add an HTTP/2 fake transport test that verifies a single `http2.connect` session, `POST` request, `:authority`, `:path`, and `:method`; close the session after one response. Add a Gateway test that maps `101/snap-ws-auth` to `protocol: "websocket"` and `401` to a safe status observation.

- [ ] **Step 2: Run the probe tests and observe red**

Run:

```powershell
npx vitest run tests/diagnostics/auth-binding-probe.test.ts
```

Expected: FAIL because `runNodeAuthBindingProbe` does not exist.

- [ ] **Step 3: Implement the one-shot probe API**

Define:

```ts
export type NodeAuthBindingMode = "node-http1" | "node-http2" | "node-gateway";

export interface NodeAuthBindingProbeInput {
  readonly authEpoch: string;
  readonly context: "node-http1" | "node-http2" | "node-gateway";
  readonly request?: ReadOnlyAuthProbeInput["request"];
  readonly auth: { readonly httpToken: string; readonly cookieHeader: string; readonly gatewayToken?: string };
}

export interface NodeAuthBindingProbeDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly http2Connect?: typeof import("node:http2").connect;
  readonly gatewayProbe?: typeof probeGatewayHandshake;
  readonly now?: () => Date;
}

export function runNodeAuthBindingProbe(
  input: NodeAuthBindingProbeInput,
  dependencies?: NodeAuthBindingProbeDependencies,
): Promise<SafeAuthBindingObservation>;
```

For `node-http1`, call the existing allowlisted read-only probe with one explicit HTTP/1.1 fetch. For `node-http2`, use `node:http2.connect("https://web.snapchat.com")`, send one POST, apply a 10-second timeout, return one observation, and close the session in all paths. For `node-gateway`, call `probeGatewayHandshake` once with the session Gateway token and map only status, classification, protocol, and duration. Do not alter TLS ciphers, ALPN, certificate validation, proxy settings, or WebSocket headers to mimic a browser.

- [ ] **Step 4: Run focused tests and commit**

Run:

```powershell
npx vitest run tests/diagnostics/auth-binding-probe.test.ts
npm run typecheck
```

Expected: PASS. Then commit:

```powershell
git add src/diagnostics/auth-binding-probe.ts tests/diagnostics/auth-binding-probe.test.ts
git commit -m "feat: add one-shot auth binding probes"
```

### Task 4: Add the CLI and sanitized observation-file workflow

**Files:**
- Create: `src/cli/commands/debug-auth-binding.ts`
- Modify: `src/cli/index.ts`
- Modify: `tests/cli/commands.test.ts`
- Create: `tests/fixtures/auth-binding-observations.json`

**Interfaces:**
- Consumes: ignored HAR/session/request files and tracked sanitized observation JSON.
- Produces: safe JSON only.

- [ ] **Step 1: Write failing CLI routing tests**

Add tests for these exact commands:

```text
debug auth-binding har --file private/fresh7.har --epoch fresh7
debug auth-binding probe --request private/edge-delta-probe.json --mode node-http2 --epoch fresh7
debug auth-binding gateway --mode node-gateway --epoch fresh7
debug auth-binding classify --observations tests/fixtures/auth-binding-observations.json
```

Assert that missing `SNAP_LIVE_TESTS=1` blocks `probe`, `har` works without live access, `classify` works offline, paths outside the configured private/session scope are rejected, and no output contains sentinel credentials. Assert invalid mode, non-allowlisted endpoint, duplicate flag, and missing epoch return `INVALID_CONFIG`.

- [ ] **Step 2: Run CLI tests and observe red**

Run:

```powershell
npx vitest run tests/cli/commands.test.ts
```

Expected: FAIL because the new route and command do not exist.

- [ ] **Step 3: Implement the exact subcommands**

Implement these forms:

```text
snap debug auth-binding har --file <har> --epoch <label>
snap debug auth-binding probe --request <request> --mode node-http1|node-http2 --epoch <label>
snap debug auth-binding gateway --mode node-gateway --epoch <label>
snap debug auth-binding classify --observations <safe-json>
```

`har` parses metadata only. `probe` loads the configured sealed session through `SealedSessionStore`, verifies account/build, and performs exactly one read-only call. `gateway` performs exactly one handshake probe. `classify` accepts only the validated `SafeAuthBindingObservation[]` shape and emits `{ type: "debug.auth-binding", conclusion: ... }`. Every error uses existing `redact()` behavior and excludes loaded file content.

- [ ] **Step 4: Add the sanitized fixture and verify**

The fixture must contain two or more observations with labels such as `epoch-a`, statuses, protocol labels, body byte length, and a 64-character body SHA-256 made only of `a`; it must not contain strings matching `Bearer`, `Cookie`, `snap-ws-auth,`, or credential-like values longer than 80 characters.

Run:

```powershell
npx vitest run tests/cli/commands.test.ts
npm run typecheck
npm run build
```

Expected: PASS. Then commit:

```powershell
git add src/cli/commands/debug-auth-binding.ts src/cli/index.ts tests/cli/commands.test.ts tests/fixtures/auth-binding-observations.json
git commit -m "feat: add auth binding diagnostic CLI"
```

### Task 5: Add the external .NET HTTP/3 probe

**Files:**
- Create: `scripts/probe-auth-binding-http3.ps1`
- Create: `tests/tools/probe-auth-binding-http3-script.test.ts`

**Interfaces:**
- Consumes: a HAR file containing one successful read-only Messaging request.
- Produces: one sanitized JSON observation; never prints request headers, token values, or body bytes.

- [ ] **Step 1: Write the script contract test**

The test reads the script text and asserts that it contains: `HttpClient`, `DefaultRequestVersion = [Version]::new(3,0)`, `RequestVersionExact`, `BatchDeltaSync`/`DeltaSync` allowlisting, `response.Version`, status-only output, and no `Write-Host`/`Write-Output` of headers or body. It also rejects script text containing `Authorization` or `Cookie` in the output object.

- [ ] **Step 2: Run the script contract test and observe red**

Run:

```powershell
npx vitest run tests/tools/probe-auth-binding-http3-script.test.ts
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the one-shot PowerShell probe**

The script must accept exactly `-HarPath` and `-AuthEpoch`, parse the latest successful allowlisted `DeltaSync` or `BatchDeltaSync` entry, send one HTTP/3 POST with the captured request in memory, and emit only:

```json
{"authEpoch":"fresh7","context":"dotnet-http3","operation":"messaging-read","endpointPath":"/messagingcoreservice.MessagingCoreService/DeltaSync","status":401,"protocol":"h3","requestBodyBytes":65,"requestBodySha256":"...","safeHeaderNames":["..."]}
```

Do not print the error message, response body, request headers, token, Cookie, or body content. On `429`, print the sanitized status then exit nonzero so the operator stops all probes.

- [ ] **Step 4: Run offline script checks and commit**

Run:

```powershell
npx vitest run tests/tools/probe-auth-binding-http3-script.test.ts
pwsh -NoProfile -File scripts/probe-auth-binding-http3.ps1 -HarPath private/fresh7.har -AuthEpoch fresh7
```

Expected: the script emits one sanitized JSON object and no secret-bearing fields. Then commit:

```powershell
git add scripts/probe-auth-binding-http3.ps1 tests/tools/probe-auth-binding-http3-script.test.ts
git commit -m "feat: add sanitized HTTP3 auth binding probe"
```

### Task 6: Run the managed live experiment matrix

**Files:**
- Read only: `private/fresh7.har` and newly operator-exported HAR files.
- Append only sanitized results: `docs/runtime-feasibility-report.md`.

**Interfaces:**
- Consumes: fresh browser HARs and the configured sealed session.
- Produces: one or more validated `SafeAuthBindingObservation` objects and a classifier result.

- [ ] **Step 1: Establish a fresh browser baseline**

In the user’s logged-in Brave tab, let Snapchat perform normal background synchronization. Export a HAR containing a successful Gateway `101` and successful read-only Messaging `200`; do not include a manual send. Name it `private/auth-binding-natural.har`. Run:

```powershell
node dist/cli/index.js debug auth-binding har --file private/auth-binding-natural.har --epoch natural-1
```

Stop immediately if the summary reports no Gateway `101`, no read-only Messaging success, a write endpoint, `429`, or mismatched Gateway/Messaging token.

- [ ] **Step 2: Run the Node probes once**

Run:

```powershell
$env:SNAP_LIVE_TESTS="1"
node dist/cli/index.js debug auth-binding probe --request private/edge-delta-probe.json --mode node-http1 --epoch natural-1
node dist/cli/index.js debug auth-binding probe --request private/edge-delta-probe.json --mode node-http2 --epoch natural-1
node dist/cli/index.js debug auth-binding gateway --mode node-gateway --epoch natural-1
```

Record only the emitted sanitized JSON. Do not repeat a mode after `401`, `403`, `429`, timeout, or connection error.

- [ ] **Step 3: Run the .NET HTTP/3 probe once**

Run:

```powershell
pwsh -NoProfile -File scripts/probe-auth-binding-http3.ps1 -HarPath private/auth-binding-natural.har -AuthEpoch natural-1
```

If the result is `429` or an account warning, stop. A `401` is evidence; it is not a retry invitation.

- [ ] **Step 4: Collect a reload epoch without automating login**

Reload the already logged-in Brave page manually and wait for natural read-only synchronization. Export `private/auth-binding-reload.har`, then run:

```powershell
node dist/cli/index.js debug auth-binding har --file private/auth-binding-reload.har --epoch reload-1
```

Compare only sanitized summaries. If the Gateway token equality with the baseline is false, do not classify connection binding from this epoch; classify it as a new auth epoch.

- [ ] **Step 5: Collect a process-restart epoch**

Close Brave normally, restart the same profile manually, and wait for natural synchronization. Export `private/auth-binding-restart.har`, then summarize it with epoch `restart-1`. Do not inspect browser profile files, cookie stores, Local Storage, password stores, DBSC keys, or DevTools protocol secrets.

- [ ] **Step 6: Collect the h2 comparison epoch**

Close all Brave windows and start the installed Brave binary with `--disable-quic` using the normal user profile. Manually open the already authorized Snapchat page and wait for natural read-only synchronization. Export `private/auth-binding-h2.har`, summarize it with epoch `h2-1`, and record whether successful Messaging entries report `h2` rather than `h3`. Do not automate login or verification.

- [ ] **Step 7: Use page replay only if freshness remains unresolved**

From the existing logged-in page, perform at most one replay of an allowlisted read-only request in the same execution context. Abort if the request path is not `DeltaSync`, `BatchDeltaSync`, `GetGroups`, or Gateway handshake. Ingest only a sanitized observation file; do not store raw headers/body or replay any write RPC.

- [ ] **Step 8: Classify the accumulated observations**

Create a sanitized `private/auth-binding-observations.json` from the command outputs, then run:

```powershell
node dist/cli/index.js debug auth-binding classify --observations private/auth-binding-observations.json
```

The classifier must return one narrow conclusion or `insufficient-evidence`. Do not manually upgrade a broad `server-side-browser-binding` result to DBSC, attestation, TLS fingerprint, or connection binding without a discriminating observation.

### Task 7: Document the result and verify repository integrity

**Files:**
- Modify: `docs/runtime-feasibility-report.md`
- Modify only if command usage changed: `README.md`

**Interfaces:**
- Consumes: sanitized summaries and the classifier output.
- Produces: an evidence-backed operator report and a clean offline build.

- [ ] **Step 1: Append the sanitized evidence table**

Record one row per context with epoch label, operation, endpoint path, protocol, status, body byte length/hash, token-equality boolean, connection/process/route equality booleans, and conclusion. Explicitly record that `private/fresh7.har` had Browser Gateway `101` and Messaging `200`, while Node and .NET replay attempts returned `401`.

- [ ] **Step 2: State the narrowest supported conclusion**

Use exactly one of the classifier kinds. If the result is `server-side-browser-binding` or `insufficient-evidence`, state what remains unresolved and that no CLI bypass or credential-key extraction is supported. Do not claim Chat receive or Gateway has been fixed by diagnostics alone.

- [ ] **Step 3: Run the full offline gate**

Run serially:

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run build
git diff --check
git fsck --full --no-reflogs
```

Expected: tests, typecheck, build, and diff checks exit `0`; `git fsck` reports no broken refs or invalid pointers. Live artifacts under ignored `private/` must not appear in `git status`.

- [ ] **Step 4: Commit the report**

Run:

```powershell
git add docs/runtime-feasibility-report.md README.md
git commit -m "docs: record auth binding investigation results"
```

Do not commit HAR files, sanitized observation files under `private/`, session exports, or any credential-bearing artifact.

## Acceptance Criteria

- `debug auth-binding har` identifies Gateway `101`, read-only Messaging successes, protocol labels, and token equality without emitting credentials.
- Node HTTP/1.1, Node HTTP/2, and Node Gateway probes each perform at most one read-only request and return sanitized observations.
- The .NET HTTP/3 probe returns one sanitized observation and does not print headers, bodies, or error text.
- The classifier returns `insufficient-evidence` unless observations satisfy the exact comparison predicates for a narrower conclusion.
- Browser reload, process restart, and `--disable-quic` are operator-driven and do not automate login or verification.
- No production Chat/Snap send path changes during the investigation.
- Full serial tests, typecheck, build, diff check, and Git integrity check pass.
- The report distinguishes confirmed facts, excluded hypotheses, unresolved alternatives, and the exact next step.

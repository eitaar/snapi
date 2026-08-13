# Snapchat Gateway Protocol Analysis Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine the observable structure and state transitions of the Snapchat Web Gateway from local HAR captures and the existing pinned runtime, then document which parts are implemented, inferred, or still unknown.

**Architecture:** Treat the Gateway as a WebSocket transport carrying Snapchat-specific binary/application frames. Analyze only local captures and source/assets already present in the workspace; compare the observed connection metadata and decoded-safe frame descriptors with the CLI's transport and official runtime boundaries. The result is an evidence-separated protocol report and regression fixtures, not a replay client or authentication bypass.

**Tech Stack:** Node.js, TypeScript, Vitest, PowerShell, local HAR files, pinned Snapchat Web build `8dd50222`.

## Global Constraints

- Do not print, persist, or expose Cookie, bearer, attestation, signed URL, key, contact ID, message body, or media bytes.
- Do not automate login, OTP, CAPTCHA, browser profile extraction, DBSC bypass, or authentication-context bypass.
- Do not replay captured authenticated requests against official servers.
- Keep protocol observations build-specific to `8dd50222` and label inference separately from direct evidence.
- Prefer existing official distributed JS/WASM runtime boundaries; do not clean-room reimplement protected ContentEnvelope cryptography.
- Keep all new fixtures sanitized and metadata-only.

---

### Task 1: Freeze the analysis surface

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-gateway-protocol-analysis.md`
- Inspect: `private/*.har`, `src/transport/`, `src/runtime/`, `src/gateway/`, `docs/`

**Interfaces:**
- Consumes: existing local HAR captures and pinned build assets.
- Produces: an explicit list of captures, source modules, redaction rules, and analysis questions.

- [x] **Step 1: Record the scope and constraints**

  The analysis covers WebSocket handshake metadata, safe frame lengths/types, ordering, reconnect state, and the relationship to gRPC-Web RPCs. It excludes secret extraction and live replay.

- [x] **Step 2: Identify the known success captures**

  Use metadata-only parsing to identify captures containing `GET /snapchat.gateway.Gateway/WebSocketConnect` with status `101`, without printing request headers or bodies.

### Task 2: Extract Gateway evidence from local HAR files

**Files:**
- Create: `scripts/analyze-gateway-har.mjs`
- Create: `tests/tools/analyze-gateway-har.test.ts`
- Create: `tests/fixtures/gateway-har-metadata.json`

**Interfaces:**
- Consumes: a HAR path or a sanitized HAR object.
- Produces: metadata-only JSON containing capture name, build-independent request path, status, timestamps, safe header names, frame count/lengths when available, and RPC path ordering.

- [x] **Step 1: Write a failing test**

  Assert that a sanitized fixture reports one `101` Gateway handshake, does not include secret header values or body bytes, and preserves the relative ordering of Gateway and MessagingCore paths.

- [x] **Step 2: Run the focused test and observe the failure**

  Run `npm test -- --maxWorkers=1 tests/tools/analyze-gateway-har.test.ts`.

- [x] **Step 3: Implement metadata-only parsing**

  Parse request URLs, status codes, methods, safe header names, body lengths, and known path names. Hashes may be used only for fixture correlation and must not be reversible or accompanied by payloads.

- [x] **Step 4: Run the focused test and verify redaction**

  Run `npm test -- --maxWorkers=1 tests/tools/analyze-gateway-har.test.ts` and scan output for forbidden secret fields.

### Task 3: Compare the CLI Gateway implementation with evidence

**Files:**
- Inspect/modify only if needed: `src/gateway/`, `src/transport/`, `src/runtime/official-worker-entry.ts`, `src/runtime/official-websocket.ts`
- Test: `tests/gateway/`, `tests/transport/`, `tests/runtime/official-websocket.test.ts`
- Create: `docs/gateway-protocol-analysis-2026-08-13.md`

**Interfaces:**
- Consumes: Task 2 metadata and current source/runtime behavior.
- Produces: a table of direct evidence, implementation coverage, inference confidence, and blockers.

- [x] **Step 1: Trace the current Gateway call path**

  Follow CLI composition through the auth provider, runtime Worker, WebSocket adapter, Gateway envelope decoder, reconnect handling, and event stream. Record source file and function names in the report.

- [x] **Step 2: Compare state transitions**

  Compare `101` handshake, open/ready, inbound event, close, and reconnect behavior against the source. Mark any behavior not proven by local evidence as unknown.

- [x] **Step 3: Add only focused fixes backed by a failing offline test**

  If a source/fixture mismatch is found, add a regression test first and make the smallest local change. Do not add new live endpoints or request replay logic.

- [x] **Step 4: Write the evidence-separated report**

  Document: transport, handshake metadata, frame envelope shape if safely decoded by existing code, RPC relationship, reconnect lifecycle, implementation status, and exact unresolved questions.

### Task 4: Verify the analysis artifact

**Files:**
- Modify: `docs/gateway-protocol-analysis-2026-08-13.md` only for verification corrections.

**Interfaces:**
- Consumes: completed tests, typecheck, and build output.
- Produces: a reproducible offline report with no secret leakage.

- [x] **Step 1: Run the serial test suite**

  Run `npm test -- --maxWorkers=1`.

- [x] **Step 2: Run static checks**

  Run `npm run typecheck`, `npm run build`, and `git diff --check`.

- [x] **Step 3: Perform a secret-pattern scan**

  Scan only the new report/fixtures for cookie, bearer, attestation, signed URL, key, raw body, and media-value patterns; retain names and lengths only.

- [x] **Step 4: Report the result**

  State what is proven, what is inferred, what remains unimplemented, and whether a fresh browser capture is required for any next step.

---

## Self-review checklist

- [x] Every protocol claim is labeled as observed, source-confirmed, inferred, or unknown.
- [x] No secret values, authenticated payloads, media bytes, or replay instructions are present.
- [x] The report does not imply that a `101` handshake alone proves send authorization.
- [x] The offline parser has focused tests and the existing suite remains green.

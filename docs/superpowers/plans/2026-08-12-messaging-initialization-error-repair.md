# Messaging Initialization Error Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the safe root cause of an allowed official Messaging Worker initialization failure and return it from later Chat/Snap operations instead of reporting missing login state.

**Architecture:** Keep general runtime startup usable when Messaging initialization fails, but retain one sanitized initialization error. A shared guard in `worker-entry.ts` returns the manager or rethrows that error; only a genuinely absent `session.messaging` produces `SESSION_REEXPORT_REQUIRED`.

**Tech Stack:** Node.js 24, TypeScript, worker_threads, Vitest, existing `AppError` redaction and runtime protocol.

## Global Constraints

- Support only build `8dd50222`.
- Never print or persist Cookie, Bearer, DBSC, attestation, private-key, or protobuf payload values.
- Do not automate login, OTP, CAPTCHA, or browser security-context bypasses.
- Live verification is read-only; do not send a message or Snap during diagnosis.
- Preserve unrelated worktree changes and use `apply_patch` for source edits.

---

### Task 1: Add the failing regression test

**Files:**

- Create: `tests/fixtures/official-messaging-init-failure-worker.mjs`
- Modify: `tests/runtime/official-messaging-session.test.ts`
- Modify: `tests/runtime/worker-entry.test.ts` if an existing worker-entry test boundary is present; otherwise create it using the repository's Vitest conventions.

**Interfaces:**

- Consumes: `ContentRuntimeClient.initialize`, runtime dispatch, and the existing `officialConversationManager` lifecycle.
- Produces: A fixture that causes the safe `CRYPTO_RUNTIME_FAILED` duplex initialization error and a test proving later `encryptChat`/Snap operations return it.

- [ ] **Step 1: Add the failure fixture.** Return a serialized `CRYPTO_RUNTIME_FAILED` error with `details.safeMessage = "failed to create duplex client"` at the Messaging initialization boundary. Include `raw-transport-secret` only in fixture input so redaction is testable.

- [ ] **Step 2: Write the failing test.** Initialize with a valid session containing `messaging`, invoke the operation requiring the manager, and assert:

```ts
await expect(runtime.encryptChat(input)).rejects.toMatchObject({
  code: "CRYPTO_RUNTIME_FAILED",
  details: { safeMessage: "failed to create duplex client" },
});
await expect(runtime.encryptChat(input)).rejects.not.toThrow("raw-transport-secret");
```

Add a separate assertion that a session without `messaging` still returns `SESSION_REEXPORT_REQUIRED`.

- [ ] **Step 3: Verify red.** Run `npx vitest run tests/runtime/official-messaging-session.test.ts tests/runtime/worker-entry.test.ts`. It must fail because the current code replaces the initialization error with `SESSION_REEXPORT_REQUIRED`.

### Task 2: Retain and rethrow the sanitized error

**Files:**

- Modify: `src/runtime/worker-entry.ts`
- Modify: the focused tests and fixture from Task 1

**Interfaces:**

- Consumes: `canContinueWithoutMessaging(error: unknown)` and the existing `asSerializedError` redaction contract.
- Produces: `requireOfficialConversationManager(): OfficialRemote`, returning the manager or throwing the retained sanitized `AppError`.

- [ ] **Step 1: Add the guard and state.** Add `messagingInitializationError: AppError | undefined` beside `officialConversationManager`. The guard must return the manager, rethrow the retained error, or produce the existing missing-state error:

```ts
function requireOfficialConversationManager(): OfficialRemote {
  if (officialConversationManager !== undefined) return officialConversationManager;
  if (messagingInitializationError !== undefined) throw messagingInitializationError;
  throw new AppError(
    "SESSION_REEXPORT_REQUIRED",
    "Session export is missing login-time messaging key initialization state",
  );
}
```

Convert unknown errors to `CRYPTO_RUNTIME_FAILED` with `errorName` only; preserve an `AppError` through the existing safe details contract.

- [ ] **Step 2: Store lifecycle state.** Clear manager/error at initialization start and shutdown/reset. In the allowed failure branch, retain the sanitized error; on successful manager creation, leave it undefined.

- [ ] **Step 3: Route operations through the guard.** Replace duplicated manager-missing checks in `createOfficialPhotoSnap` and the `encryptChat` dispatch case. Keep the missing-state code only for the no-`messaging` path.

- [ ] **Step 4: Verify green.** Run the focused Vitest command from Task 1. Expected: PASS, including safe error propagation and the genuine missing-state case.

### Task 3: Full verification and live classification

**Files:**

- Modify: `docs/runtime-feasibility-report.md` only if the safe error changes the recorded diagnosis.
- Modify: `README.md` or `docs/security-boundaries.md` only if command behavior documentation becomes inaccurate.

**Interfaces:**

- Consumes: repaired runtime error path and current session state without exposing credential values.
- Produces: test/build results and a safe read-only live diagnosis.

- [ ] **Step 1: Run `npm test`; expected all existing tests pass with known skips only.**

- [ ] **Step 2: Run `npm run typecheck` and `npm run build`; both must exit successfully.**

- [ ] **Step 3: Run the read-only command `node dist/cli/index.js friends list --json`. Record only safe code, message, status, endpoint path, and initialization stage. Do not retry sending.

- [ ] **Step 4: If the result is duplex/Gateway authorization, document the local error-reporting fix and external browser-bound limitation. If it is a local state defect, add a focused regression test before changing production behavior.

- [ ] **Step 5: Run `git diff --check -- ':!/.superpowers/**'` and `git status --short`; report exact files and results without claiming Snap delivery.

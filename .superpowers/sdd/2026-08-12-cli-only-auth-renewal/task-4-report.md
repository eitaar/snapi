# Task 4 Report: Propagate refreshed credentials into the official Worker

## Summary

Implemented the missing runtime auth-update boundary so a refreshed `SessionExport` updates the existing in-memory official runtime without sending protected messaging key material into the nested official Worker. The normal client now updates the runtime only after persisted session auth is written successfully, and friend-list retry uses that refreshed runtime state before the safe read-only retry.

## Files changed for Task 4

- `src/runtime/protocol.ts`
- `src/runtime/worker-client.ts`
- `src/runtime/worker-entry.ts`
- `src/runtime/official-worker-client.ts`
- `src/client.ts`
- `tests/runtime/worker-client.test.ts`
- `tests/runtime/official-messaging-session.test.ts`
- `tests/client.test.ts`
- `tests/fixtures/runtime-worker.ts`
- `tests/fixtures/official-session-contract-worker.mjs`
- `src/runtime/official-worker-entry.ts`
- `src/friends/client.ts`

## RED evidence

Focused command from the brief:

```powershell
npm test -- tests/runtime/worker-client.test.ts tests/runtime/official-messaging-session.test.ts tests/client.test.ts
```

Observed failing results before implementation:

- `tests/runtime/worker-client.test.ts`
  - failure: `TypeError: runtime.updateAuth is not a function`
- `tests/runtime/official-messaging-session.test.ts`
  - failure: `TypeError: client.updateAuth is not a function`
- `tests/client.test.ts`
  - failure: friend listing still rejected with `AppError: friend sync expired`

Interpretation:

- the runtime protocol lacked an `updateAuth` command
- the nested official runtime had no method to refresh only in-memory auth state
- the normal client had no persisted-then-update-runtime boundary before read-only retry

## GREEN evidence

Focused verification command:

```powershell
npm test -- tests/runtime/worker-client.test.ts tests/runtime/official-messaging-session.test.ts tests/client.test.ts
```

Passing result:

- `Test Files  3 passed (3)`
- `Tests  20 passed (20)`
- exit code `0`

## Behavior implemented

### Runtime protocol boundary

- added `RuntimeCommand | { method: "updateAuth"; auth: RuntimeAuthUpdate }`
- added `ContentRuntimeClient.updateAuth(session)`
- routed the command through `src/runtime/worker-entry.ts` to the nested `OfficialWorkerClient`

### Official runtime in-memory update

- `OfficialWorkerClient.initializeWasm(session)` now seeds mutable safe auth-getter state
- `OfficialWorkerClient.updateAuth(auth)` updates only:
  - `webCookieHeader`
  - `ssoCookieHeader`
  - `officialHttpToken`
  - safe request-header getter state for `mcs-cof-ids-bin`
- the update path does not send protected messaging key material into the nested official Worker

### Client persistence and retry boundary

- `src/client.ts` now updates the runtime from the `AuthProvider.persist` callback only after the persisted auth write succeeds
- if the runtime does not exist yet, no runtime update is attempted during initial auth setup
- the read-only friend sync path catches `SESSION_EXPIRED`, runs `auth.refreshOnce({ kind: "expired" })`, and retries only after the persistence callback has already updated the runtime

## Tests added/updated

- `tests/runtime/worker-client.test.ts`
  - proves `updateAuth` changes the next read-only runtime behavior
- `tests/runtime/official-messaging-session.test.ts`
  - proves refreshed auth reaches the in-memory official runtime before the next read-only call
- `tests/client.test.ts`
  - proves ordering: persistence write completes before runtime update, and runtime update completes before friend-list retry
- focused fixtures updated to verify behavior without asserting or logging raw secret values

## Self-review

- kept retry logic at the normal client boundary with the friend adapter explicitly listed in the Task 4 files
- verified the update path is limited to auth headers/tokens/cookies and safe getter state
- kept assertions secret-safe: tests check state transitions and ordering, not raw auth values in output
- used the exact focused RED/GREEN command from the brief

## Concerns / follow-up notes

- the Task 4 commit includes the existing friend/Snap runtime support that shares the runtime files; those files are listed explicitly above so the mixed scope is not hidden

## Fix round 1

Fix round 1 changed exactly these 8 files: `src/runtime/protocol.ts`, `src/runtime/worker-client.ts`, `src/runtime/worker-entry.ts`, `src/runtime/official-worker-client.ts`, `src/runtime/official-worker-entry.ts`, `tests/fixtures/runtime-worker.ts`, `tests/runtime/official-messaging-session.test.ts`, and this report. The `src/friends/client.ts` entry above belongs to the initial mixed Task 4 commit and was not changed in this fix round.

- Changed the runtime command to carry `RuntimeAuthUpdate` only: account ID, HTTP token, web Cookie, SSO Cookie, and the safe MCS-Cof header value. `ContentRuntimeClient.updateAuth(SessionExport)` now extracts this payload before posting to the Worker.
- The nested official runtime accepts the auth-only payload; protected messaging state is not serialized by the update command.
- Invalid host setter arguments now throw into the existing Worker error response path instead of returning without a response and hanging the caller.
- The fixture rejects a full-session update payload so the minimization is regression-tested.

Verification:

```text
npm test -- tests/runtime/worker-client.test.ts tests/runtime/official-messaging-session.test.ts tests/client.test.ts
3 test files passed; 20 tests passed.
```

`npm run typecheck` still reports unrelated pre-existing dirty-worktree errors in the Snap event export and `src/client.ts` renewal dependency construction; no Task 4 type errors remain in the reported output.

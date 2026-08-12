# Task 4: Propagate refreshed credentials into the official Worker

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

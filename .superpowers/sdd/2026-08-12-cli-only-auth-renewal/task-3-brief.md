# Task 3: Add proactive and reactive refresh coordination for safe operations

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

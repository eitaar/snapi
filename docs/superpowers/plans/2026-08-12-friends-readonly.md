# Read-only Friend Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or execute inline with the same checkpoints when the user has already authorized continued work). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a safe read-only friend snapshot from the pinned official runtime and make it available through the Node client and CLI without printing credentials or device-key material.

**Architecture:** The official Webpack runtime remains the only owner of Snapchat friend synchronization and protobuf/network details. A host-control call asks the official runtime's initialized user store to run its existing `syncFriends()` method, then converts only public relationship metadata into a versioned, JSON-safe snapshot. The Node-facing client and CLI consume that snapshot and provide exact local lookup; no friend write operation is added before a separate live protocol test.

**Tech Stack:** TypeScript, Node worker_threads, pinned Snapchat Webpack/WASM assets, Vitest, existing gRPC/auth boundary.

## Global Constraints

- Do not perform live network calls during offline verification.
- Do not expose Cookie, bearer, attestation, root-wrapping, Fidelius, or other protected key material.
- Do not add login, OTP, CAPTCHA, friend-request mutation, block, or delete automation in this phase.
- Preserve the pinned build contract `8dd50222` and existing dirty user changes.
- Use exact matching for local friend lookup; never fuzzy-select a person.

### Task 1: Public friend snapshot contract

**Files:**
- Create: `src/friends/types.ts`
- Create: `src/friends/snapshot.ts`
- Test: `tests/friends/snapshot.test.ts`

**Interfaces:**
- `FriendRelationshipStatus = "friend" | "pending" | "following" | "blocked" | "deleted" | "unknown"`.
- `FriendRecord` contains `userId`, optional `username`, `displayName`, `status`, `direction`, `addedAt`, `requestViewed`.
- `FriendSnapshot` contains `syncedAt`, `status`, `friends`, and `incomingRequests`.
- `sanitizeFriendSnapshot(value)` drops unknown fields and all protected device/key fields.
- `findExactFriend(query, snapshot)` resolves an exact case-insensitive username/display name or exact user ID and throws the existing `RECIPIENT_NOT_FOUND` error for zero or ambiguous matches.

- [ ] Write the failing sanitizer and exact-lookup tests.
- [ ] Run `npm test -- tests/friends/snapshot.test.ts` and confirm the missing-module failure.
- [ ] Implement the minimal public types, sanitizer, and resolver.
- [ ] Rerun the focused test and confirm it passes.

### Task 2: Worker friend synchronization boundary

**Files:**
- Modify: `src/runtime/protocol.ts`
- Modify: `src/runtime/content-types.ts`
- Modify: `src/runtime/worker-client.ts`
- Modify: `src/runtime/official-worker-client.ts`
- Modify: `src/runtime/official-worker-entry.ts`
- Modify: `src/runtime/worker-entry.ts`
- Test: `tests/runtime/worker-client.test.ts`
- Test: `tests/runtime/official-worker-contract.test.ts`

**Interfaces:**
- Add runtime command `{ method: "syncFriends" }`.
- Add `ContentRuntimeClient.syncFriends(): Promise<FriendSnapshot>`.
- Add `OfficialWorkerClient.syncFriends(): Promise<FriendSnapshot>`.
- Official host control calls the initialized official user store's `syncFriends()` and reads only friend/user relationship fields; device lists and key material are excluded before crossing the worker boundary.

- [ ] Write the failing protocol/client contract tests.
- [ ] Run the focused tests and confirm `syncFriends` is absent.
- [ ] Implement the command dispatch and host-control conversion.
- [ ] Rerun focused tests and confirm the sanitized snapshot crosses the worker boundary.

### Task 3: Node client and CLI read-only surface

**Files:**
- Create: `src/friends/client.ts`
- Create: `src/cli/commands/friends-list.ts`
- Modify: `src/client.ts`
- Modify: `src/cli/index.ts`
- Modify: `README.md`
- Test: `tests/friends/client.test.ts`
- Test: `tests/cli/friends-list.test.ts`
- Test: `tests/cli/build-smoke.test.ts`

**Interfaces:**
- `FriendsClient.list(): Promise<FriendSnapshot>` calls the runtime boundary and returns safe metadata.
- `SnapchatClient.listFriends(): Promise<FriendSnapshot>` exposes the feature.
- `snap friends list [--json] [--query QUERY]` prints safe metadata only; `--query` uses exact local matching and returns an ambiguity/not-found error without selecting a candidate.

- [ ] Write failing client/CLI tests for JSON output, exact query, ambiguity, and safe fields.
- [ ] Run focused tests and confirm the command/API is missing.
- [ ] Implement the minimal client and CLI routing.
- [ ] Rerun focused tests and confirm they pass.

### Task 4: Offline verification and handoff

**Files:**
- Modify: `docs/security-boundaries.md`
- Modify: `docs/runtime-feasibility-report.md`
- Test: existing full suite

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Report that live production verification remains pending for tomorrow and name the exact command to use after authentication is available.

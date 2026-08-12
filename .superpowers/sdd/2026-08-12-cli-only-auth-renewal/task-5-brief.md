# Task 5: Add the CLI-only live feasibility gate

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

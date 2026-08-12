# Task 1: Establish the CLI-only renewal capability contract

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

# Task 2: Make the existing CLI refresh pipeline explicit and capability-aware

**Files:**
- Modify: `src/transport/sso-auth-refresh.ts`
- Modify: `src/auth/dbsc.ts`
- Modify: `src/auth/brave-cookies.ts`
- Modify: `src/client.ts`
- Test: `tests/transport/sso-auth-refresh.test.ts`
- Test: `tests/auth/dbsc.test.ts`
- Test: `tests/auth/brave-cookies.test.ts`

**Interfaces:**
- Consumes: `SNAP_COOKIE_HEADER`, `SNAP_SSO_COOKIE_HEADER`, `SNAP_BRAVE_PROFILE_DIR`, and the existing session fields.
- Produces:

```ts
export interface CliRenewalOptions {
  readonly profileDir?: string;
  readonly allowLegacyBraveCookies: boolean;
  readonly allowDbsc: boolean;
  readonly allowWebAttestation: boolean;
}

export function refreshSnapchatSso(
  session: SessionExport,
  dependencies?: SsoRefreshDependencies,
): Promise<SessionExport>;
```

- [ ] **Step 1: Write failing tests for source selection and fail-closed behavior**

Add cases proving:

```ts
it("uses an explicit SSO Cookie source before a profile source", async () => {
  // supply both sources and assert only the explicit source is called
});

it("does not treat a 303 or 403 as a successful refresh", async () => {
  // return a redirect/403 response and assert AUTH_CONTEXT_UNAVAILABLE
});

it("does not attempt v20 decryption", async () => {
  // supply an unsupported app-bound cookie marker and assert a safe unavailable error
});
```

The tests must inspect call order and safe status only, never token or cookie values.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npm test -- tests/transport/sso-auth-refresh.test.ts tests/auth/dbsc.test.ts tests/auth/brave-cookies.test.ts
```

Expected: the new capability-selection assertions fail before implementation.

- [ ] **Step 3: Implement capability selection without changing cryptographic boundaries**

Use this order:

1. Explicit session/configured Cookie override.
2. Legacy v10/v11 Cookie decryption from the configured Brave profile.
3. DBSC challenge/sign/refresh using the existing Windows CNG signer.
4. Web Attestation WASM generation.
5. SSO POST with `redirect: "manual"`.

Keep the SSO response validation strict: 2xx plus a valid token and matching `scuid` is success; 3xx, 4xx, malformed token, or account mismatch is failure. Do not write a partially refreshed session.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused command and expect all existing and new tests to pass.

- [ ] **Step 5: Commit the capability pipeline**

```powershell
git add src/transport/sso-auth-refresh.ts src/auth/dbsc.ts src/auth/brave-cookies.ts src/client.ts tests/transport/sso-auth-refresh.test.ts tests/auth/dbsc.test.ts tests/auth/brave-cookies.test.ts
git commit -m "feat: make CLI auth renewal capability-aware"
```

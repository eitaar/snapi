# Multi-Account Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, isolated multi-account profiles so `snaapi --account <alias> ...` can operate separate sealed sessions while preserving the existing single-account environment workflow.

**Architecture:** Store non-secret profile metadata under `private/accounts`, derive account/build identity from each DPAPI-sealed session, and resolve one immutable `AppConfig` before a command performs work. Inject that config through CLI factories instead of mutating `process.env`; use a shared profile-root lock directory keyed by account ID so duplicate aliases cannot operate one account concurrently.

**Tech Stack:** Node.js 24 ESM, TypeScript 6 strict mode, Vitest 4, existing DPAPI `SealedSessionStore`, existing `CompatibilityGuard`, PowerShell CLI examples.

**Spec:** `docs/superpowers/specs/2026-08-14-multi-account-profiles-design.md`

## Global Constraints

- Preserve `snap` and `snaapi` as aliases for the same CLI.
- Preserve legacy `SNAP_SESSION_FILE`, `SNAP_ASSET_DIR`, `SNAP_ACCOUNT_ID`, and `SNAP_BUILD_ID` behavior when no profile is selected.
- Resolve precedence as explicit `--account`, then `SNAAPI_ACCOUNT`, then legacy environment configuration.
- Never print or copy Cookie values, Bearer tokens, E2EE keys, raw HAR data, or sealed session contents.
- Never mutate `process.env` to switch accounts.
- Profile aliases must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- Separate accounts may run concurrently; the same account remains single-writer across all aliases.
- Do not automate login, OTP, CAPTCHA, DBSC key access, or browser profile-file access.
- Do not stage or revert unrelated changes already present in the working tree.
- Automated acceptance is offline; do not send a live Chat or Snap while implementing this feature.

---

### Task 1: Versioned account profile storage

**Files:**
- Create: `src/accounts/types.ts`
- Create: `src/accounts/profile-store.ts`
- Test: `tests/accounts/profile-store.test.ts`

**Interfaces:**
- Consumes: filesystem paths and the existing `AppError` error type.
- Produces: `AccountProfileV1`, `AccountProfileRecord`, `AccountProfileSummary`, `assertAccountAlias(alias)`, and `AccountProfileStore` with `read`, `add`, `list`, and `pathFor` methods.

- [ ] **Step 1: Write failing alias and profile-store tests**

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AccountProfileStore, assertAccountAlias } from "../../src/accounts/profile-store.js";

describe("AccountProfileStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("rejects traversal and accepts a bounded alias", () => {
    expect(assertAccountAlias("main.bot-1")).toBe("main.bot-1");
    expect(() => assertAccountAlias("../main")).toThrowError(/alias/i);
    expect(() => assertAccountAlias("a".repeat(65))).toThrowError(/alias/i);
  });

  test("writes versioned relative path metadata atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "snaapi-accounts-"));
    roots.push(root);
    const store = new AccountProfileStore(root);
    await store.add("main", {
      sessionFile: join(root, "sessions", "main.json"),
      assetDir: join(root, "assets", "da4d065e"),
    });

    expect(await store.read("main")).toMatchObject({
      alias: "main",
      sessionFile: join(root, "sessions", "main.json"),
      assetDir: join(root, "assets", "da4d065e"),
    });
    expect(JSON.parse(await readFile(join(root, "main.json"), "utf8"))).toEqual({
      formatVersion: 1,
      sessionFile: "sessions/main.json",
      assetDir: "assets/da4d065e",
    });
  });

  test("fails closed instead of replacing an existing alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "snaapi-accounts-"));
    roots.push(root);
    const store = new AccountProfileStore(root);
    const input = { sessionFile: join(root, "one.json"), assetDir: join(root, "assets") };
    await store.add("main", input);
    await expect(store.add("main", input)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/accounts/profile-store.test.ts --maxWorkers=1`

Expected: FAIL because `src/accounts/profile-store.ts` does not exist.

- [ ] **Step 3: Implement the profile schema, path normalization, and atomic create**

```ts
// src/accounts/types.ts
export interface AccountProfileV1 {
  readonly formatVersion: 1;
  readonly sessionFile: string;
  readonly assetDir: string;
}

export interface AccountProfileRecord {
  readonly alias: string;
  readonly sessionFile: string;
  readonly assetDir: string;
}

export interface AccountProfileSummary {
  readonly alias: string;
  readonly status: "ready" | "missing-session" | "invalid";
  readonly buildId?: string;
}
```

Implement `AccountProfileStore` with these rules:

```ts
const ACCOUNT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertAccountAlias(alias: string): string {
  if (!ACCOUNT_ALIAS.test(alias)) {
    throw new AppError("INVALID_CONFIG", "Account alias is invalid", { alias });
  }
  return alias;
}
```

`add` must create the root, write a unique temporary file in the same directory
with mode `0o600`, sync and close it, then rename it to `<alias>.json` only if
that destination does not already exist. Store forward-slash relative paths;
`read` resolves them relative to the profile JSON directory and rejects unknown
`formatVersion`, absolute stored paths, malformed JSON, and missing string
fields with `INVALID_CONFIG`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/accounts/profile-store.test.ts --maxWorkers=1`

Expected: all profile-store tests PASS.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add src/accounts/types.ts src/accounts/profile-store.ts tests/accounts/profile-store.test.ts
git commit -m "feat: add account profile storage"
```

---

### Task 2: Resolve profile-backed `AppConfig` and global lock paths

**Files:**
- Modify: `src/config.ts`
- Modify: `src/client.ts`
- Test: `tests/config.test.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: `AccountProfileStore.read(alias)`, `loadSession(sessionFile)`, existing cookie override parsing, and existing build IDs.
- Produces: `AppConfig.lockDir`, `ResolveAppConfigOptions`, `ResolveAppConfigDependencies`, and `resolveAppConfig(options, dependencies)`.

- [ ] **Step 1: Add failing resolver tests**

Add tests that inject a profile store and session loader without reading real
credentials:

```ts
it("derives profile identity from its sealed session metadata", async () => {
  const config = await resolveAppConfig(
    { accountAlias: "main", env: { SNAP_OUTPUT: "json" } },
    {
      accountsDir: "C:/repo/private/accounts",
      readProfile: async () => ({
        alias: "main",
        sessionFile: "C:/repo/private/main-session.json",
        assetDir: "C:/repo/private/da4d-assets",
      }),
      loadSession: async () => session({
        accountId: "11111111-2222-4333-8444-555555555555",
        buildId: "da4d065e",
      }),
    },
  );

  expect(config).toMatchObject({
    accountId: "11111111-2222-4333-8444-555555555555",
    buildId: "da4d065e",
    sessionFile: "C:/repo/private/main-session.json",
    assetDir: "C:/repo/private/da4d-assets",
    lockDir: "C:/repo/private/accounts/.locks",
    output: "json",
  });
});

it("keeps legacy configuration when no alias is selected", async () => {
  const config = await resolveAppConfig({ env: legacyEnvironment });
  expect(config.sessionFile).toBe(resolve("private/session.json"));
  expect(config.lockDir).toBe(resolve("private/locks"));
});
```

Add a client test proving the lock constructor receives `config.lockDir`, not
`dirname(config.sessionFile)/locks`.

- [ ] **Step 2: Run resolver/client tests and verify RED**

Run: `npm test -- tests/config.test.ts tests/client.test.ts --maxWorkers=1`

Expected: FAIL because `resolveAppConfig` and `AppConfig.lockDir` do not exist.

- [ ] **Step 3: Add the asynchronous resolver**

Add these public types to `src/config.ts`:

```ts
export interface ResolveAppConfigOptions {
  readonly accountAlias?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface ResolveAppConfigDependencies {
  readonly accountsDir?: string;
  readonly readProfile?: (alias: string) => Promise<AccountProfileRecord>;
  readonly loadSession?: typeof loadSession;
}
```

Extend `AppConfig`:

```ts
readonly lockDir: string;
readonly accountAlias?: string;
```

In legacy `loadConfig`, set:

```ts
const sessionFile = resolve(required(env, "SNAP_SESSION_FILE"));
return {
  sessionFile,
  lockDir: join(dirname(sessionFile), "locks"),
  // existing fields unchanged
};
```

In `resolveAppConfig`, profile mode must:

1. Resolve `SNAAPI_ACCOUNTS_DIR` or `<cwd>/private/accounts`.
2. Read the selected profile.
3. Read the DPAPI-sealed session through `loadSession`.
4. Validate its build with `isSupportedBuildId`.
5. Return identity from the session and paths from the profile.
6. Apply only output and optional Cookie overrides from the supplied env.

- [ ] **Step 4: Make every client lock use `config.lockDir`**

Change `src/client.ts` from:

```ts
new AccountLock(join(dirname(config.sessionFile), "locks"))
```

to:

```ts
new AccountLock(config.lockDir)
```

Remove imports that become unused.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/config.test.ts tests/client.test.ts --maxWorkers=1`

Expected: all resolver and client tests PASS.

- [ ] **Step 6: Commit only Task 2 files**

```powershell
git add src/config.ts src/client.ts tests/config.test.ts tests/client.test.ts
git commit -m "feat: resolve account profile configuration"
```

---

### Task 3: Parse global account selection without polluting subcommands

**Files:**
- Create: `src/cli/global-options.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/global-options.test.ts`
- Test: `tests/cli/commands.test.ts`

**Interfaces:**
- Consumes: CLI argv and `SNAAPI_ACCOUNT`.
- Produces: `GlobalCliOptions`, `parseGlobalCliOptions(argv, env)`, and a lazy `resolveConfig()` dependency available to routed commands.

- [ ] **Step 1: Write failing option precedence and stripping tests**

```ts
describe("parseGlobalCliOptions", () => {
  test("strips an explicit account prefix and gives it precedence", () => {
    expect(parseGlobalCliOptions(
      ["--account", "bot", "chat", "send", "recipient", "hello"],
      { SNAAPI_ACCOUNT: "main" },
    )).toEqual({
      accountAlias: "bot",
      argv: ["chat", "send", "recipient", "hello"],
    });
  });

  test("uses the per-shell default without changing command arguments", () => {
    expect(parseGlobalCliOptions(["friends", "list", "--easy"], {
      SNAAPI_ACCOUNT: "main",
    })).toEqual({ accountAlias: "main", argv: ["friends", "list", "--easy"] });
  });

  test("rejects a missing or unsafe explicit alias", () => {
    expect(() => parseGlobalCliOptions(["--account"], {})).toThrowError(/account/i);
    expect(() => parseGlobalCliOptions(["--account", "../main", "friends", "list"], {}))
      .toThrowError(/alias/i);
  });
});
```

Add a `main` routing test that supplies `resolveConfig` and asserts the selected
alias is passed exactly once while the command handler receives argv without
the global option.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `npm test -- tests/cli/global-options.test.ts tests/cli/commands.test.ts --maxWorkers=1`

Expected: FAIL because the parser and account-aware dependency do not exist.

- [ ] **Step 3: Implement the prefix parser**

```ts
export interface GlobalCliOptions {
  readonly accountAlias?: string;
  readonly argv: readonly string[];
}

export function parseGlobalCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): GlobalCliOptions {
  if (argv[0] === "--account") {
    const alias = argv[1];
    if (alias === undefined) {
      throw new AppError("INVALID_CONFIG", "--account requires an alias");
    }
    return { accountAlias: assertAccountAlias(alias), argv: argv.slice(2) };
  }
  const alias = env.SNAAPI_ACCOUNT?.trim();
  return alias === undefined || alias === ""
    ? { argv }
    : { accountAlias: assertAccountAlias(alias), argv };
}
```

Only the leading `--account <alias>` form is accepted. Do not scan later
arguments because subcommands own their own option namespaces.

- [ ] **Step 4: Resolve configuration lazily in the CLI**

Extend `CliDependencies` with:

```ts
readonly env?: NodeJS.ProcessEnv;
readonly resolveConfig?: (accountAlias?: string) => Promise<AppConfig>;
readonly createClient?: (config: AppConfig) => Promise<ConfiguredCliClient>;
readonly createGatewayStatusClient?: (config: AppConfig) => Promise<ConfiguredGatewayStatusClient>;
```

At the start of `main`, parse global options and retain a memoized resolver:

```ts
const global = parseGlobalCliOptions(argv, dependencies.env ?? process.env);
argv = global.argv;
let configPromise: Promise<AppConfig> | undefined;
const config = () => configPromise ??= dependencies.resolveConfig?.(global.accountAlias)
  ?? resolveAppConfig({ accountAlias: global.accountAlias, env: dependencies.env });
```

Keep `--version` and `account` management commands free of account resolution.
Client-backed commands call `createConfiguredClient(await config())`.

- [ ] **Step 5: Update usage text to use `snaapi`**

Replace top-level and command usage prefixes with `snaapi` while retaining the
`snap` executable alias. Assertions should expect the new text.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- tests/cli/global-options.test.ts tests/cli/commands.test.ts --maxWorkers=1`

Expected: all global option and routing tests PASS.

- [ ] **Step 7: Commit only Task 3 files**

```powershell
git add src/cli/global-options.ts src/cli/index.ts tests/cli/global-options.test.ts tests/cli/commands.test.ts
git commit -m "feat: select account profiles from the CLI"
```

---

### Task 4: Add safe account management commands

**Files:**
- Create: `src/cli/commands/account-add.ts`
- Create: `src/cli/commands/account-list.ts`
- Create: `src/cli/commands/account-show.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/account-commands.test.ts`

**Interfaces:**
- Consumes: `AccountProfileStore`, `loadSession`, `AssetLoader`, `CompatibilityGuard`, and `getBuildProfile`.
- Produces: `snaapi account add`, `snaapi account list`, and `snaapi account show`.

- [ ] **Step 1: Write failing account command tests**

Cover these observable contracts:

```ts
test("account add derives identity and never prints it", async () => {
  const output = io();
  const add = vi.fn(async () => ({ alias: "main", buildId: "da4d065e", status: "ready" as const }));
  const code = await runAccountAdd([
    "main", "--session", "private/main.json", "--asset-dir", "private/da4d-assets",
  ], output.value, { add });

  expect(code).toBe(0);
  expect(add).toHaveBeenCalledWith("main", {
    sessionFile: "private/main.json",
    assetDir: "private/da4d-assets",
  });
  expect(output.stdout.join("\n")).toBe("Account added: main (da4d065e, ready)");
  expect(output.stdout.join("\n")).not.toContain("11111111-2222-4333-8444-555555555555");
});

test("account list emits only alias build and status", async () => {
  const output = io();
  await runAccountList(output.value, {
    list: async () => [{ alias: "main", buildId: "da4d065e", status: "ready" }],
    output: "json",
  });
  expect(JSON.parse(output.stdout[0]!)).toEqual({
    type: "accounts.list",
    accounts: [{ alias: "main", buildId: "da4d065e", status: "ready" }],
  });
});
```

Also test duplicate alias failure, missing session, invalid profile, unsupported
build, asset verification failure, and `account show` unknown alias.

- [ ] **Step 2: Run account command tests and verify RED**

Run: `npm test -- tests/cli/account-commands.test.ts --maxWorkers=1`

Expected: FAIL because account command modules do not exist.

- [ ] **Step 3: Implement `account add`**

Parse exactly one alias plus required `--session` and `--asset-dir`. The default
implementation must:

```ts
const session = await loadSession(resolve(sessionFile));
const report = await new CompatibilityGuard(
  new AssetLoader(resolve(assetDir)),
  undefined,
  getBuildProfile(session.buildId),
).verify(session);
await store.add(alias, { sessionFile: resolve(sessionFile), assetDir: resolve(assetDir) });
return { alias, buildId: report.buildId, status: "ready" as const };
```

Do not include `session.accountId` in output or error details.

- [ ] **Step 4: Implement `account list` and `account show`**

For each profile, read metadata and then its sealed session. Return:

```ts
{ alias, buildId: session.buildId, status: "ready" }
```

Map `ENOENT` for the session to `missing-session`; map malformed profile,
unreadable session, or unsupported build to `invalid`. `account show` reports
one summary and path fields only in human output; JSON remains limited to
alias, build, status, session path, and asset path.

- [ ] **Step 5: Route account commands before profile config resolution**

Add branches for `account add`, `account list`, and `account show` in
`src/cli/index.ts`. They must use `SNAAPI_ACCOUNTS_DIR` but must not call
`resolveAppConfig`, acquire an account lock, initialize the official Worker,
or make network requests.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- tests/cli/account-commands.test.ts tests/cli/commands.test.ts --maxWorkers=1`

Expected: all account command and routing tests PASS.

- [ ] **Step 7: Commit only Task 4 files**

```powershell
git add src/cli/commands/account-add.ts src/cli/commands/account-list.ts src/cli/commands/account-show.ts src/cli/index.ts tests/cli/account-commands.test.ts tests/cli/commands.test.ts
git commit -m "feat: manage local account profiles"
```

---

### Task 5: Inject the selected config into session, Gateway, and diagnostic commands

**Files:**
- Modify: `src/cli/commands/session-check.ts`
- Modify: `src/cli/commands/session-import.ts`
- Modify: `src/cli/commands/session-refresh-har.ts`
- Modify: `src/cli/commands/session-export-cdp.ts`
- Modify: `src/cli/commands/session-login.ts`
- Modify: `src/cli/gateway-status-client.ts`
- Modify: `src/cli/commands/debug-doctor.ts`
- Modify: `src/cli/commands/debug-auth-gap.ts`
- Modify: `src/cli/commands/debug-auth-binding.ts`
- Modify: `src/cli/commands/debug-gateway-handshake.ts`
- Modify: `src/diagnostics/cli-auth-renewal.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/session-check.test.ts`
- Test: `tests/cli/session-import.test.ts`
- Test: `tests/cli/session-refresh-har.test.ts`
- Test: `tests/cli/session-export-cdp.test.ts`
- Test: `tests/cli/gateway-status-client.test.ts`
- Test: `tests/cli/debug-doctor.test.ts`
- Test: `tests/cli/debug-gateway-handshake.test.ts`
- Test: `tests/diagnostics/cli-auth-renewal.test.ts`

**Interfaces:**
- Consumes: the memoized `AppConfig` resolved in Task 3.
- Produces: command dependencies that accept `config?: AppConfig` and never independently switch accounts.

- [ ] **Step 1: Add failing selected-profile tests to every affected command family**

For each family, inject a config whose session path differs from the legacy env
and assert only the injected path is read or written. Add this lock assertion
to session and Gateway tests:

```ts
expect(AccountLock).toHaveBeenConstructedWith(config.lockDir);
```

For `session import`, assert a session for another account is rejected before
the destination is written. For `session refresh-har`, assert a HAR for another
build is rejected before persistence. For `session export-cdp` in profile mode,
assert an `--output` path different from `config.sessionFile` is rejected.

- [ ] **Step 2: Run all affected focused tests and verify RED**

Run:

```powershell
npm test -- tests/cli/session-check.test.ts tests/cli/session-import.test.ts tests/cli/session-refresh-har.test.ts tests/cli/session-export-cdp.test.ts tests/cli/gateway-status-client.test.ts tests/cli/debug-doctor.test.ts tests/cli/debug-gateway-handshake.test.ts tests/diagnostics/cli-auth-renewal.test.ts --maxWorkers=1
```

Expected: FAIL because commands still call `loadConfig()` internally or derive
locks from `dirname(sessionFile)`.

- [ ] **Step 3: Add config injection consistently**

For each command dependency interface, add:

```ts
readonly config?: AppConfig;
```

Default implementations use `dependencies.config ?? loadConfig()` only for
legacy direct invocation tests. The top-level CLI always passes the single
memoized resolved config. Replace every lock construction with:

```ts
new AccountLock(config.lockDir)
```

Do not pass profile selection through environment variables.

- [ ] **Step 4: Guard export/import destinations in profile mode**

When `config.accountAlias` is present:

```ts
if (resolve(outputPath) !== config.sessionFile) {
  throw new AppError("INVALID_CONFIG", "Profile session output path does not match the selected account");
}
```

After capture/import, compare account and build with `config` before writing.
The explicit-output bootstrap remains available without `--account`.

- [ ] **Step 5: Pass the resolved config from every CLI branch**

Every session, Gateway, and live diagnostic route must call `await config()`
and pass that value into its command dependencies. Offline HAR classification
that does not require a session may continue without resolving an account.

- [ ] **Step 6: Run affected tests and verify GREEN**

Run the same focused command from Step 2.

Expected: all affected command tests PASS with no authenticated network calls.

- [ ] **Step 7: Commit only Task 5 files**

```powershell
git add src/cli/commands/session-check.ts src/cli/commands/session-import.ts src/cli/commands/session-refresh-har.ts src/cli/commands/session-export-cdp.ts src/cli/commands/session-login.ts src/cli/gateway-status-client.ts src/cli/commands/debug-doctor.ts src/cli/commands/debug-auth-gap.ts src/cli/commands/debug-auth-binding.ts src/cli/commands/debug-gateway-handshake.ts src/diagnostics/cli-auth-renewal.ts src/cli/index.ts tests/cli/session-check.test.ts tests/cli/session-import.test.ts tests/cli/session-refresh-har.test.ts tests/cli/session-export-cdp.test.ts tests/cli/gateway-status-client.test.ts tests/cli/debug-doctor.test.ts tests/cli/debug-gateway-handshake.test.ts tests/diagnostics/cli-auth-renewal.test.ts
git commit -m "refactor: isolate command configuration by account"
```

Before running the commit command, inspect `git diff --cached --name-only` and
unstage any unrelated pre-existing test changes.

---

### Task 6: Prove cross-profile lock behavior and library-level concurrency

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration/multi-account.test.ts`
- Test: `tests/session/account-lock.test.ts`

**Interfaces:**
- Consumes: `resolveAppConfig`, `SnapchatClient.create`, shared `AppConfig.lockDir`, and `AccountLock`.
- Produces: public account profile types/resolver exports and offline concurrency proof.

- [ ] **Step 1: Write failing lock-isolation tests**

```ts
test("different account IDs can hold locks in the shared directory", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "snaapi-locks-")), ".locks");
  const locks = new AccountLock(directory);
  const first = await locks.acquire("account-one");
  const second = await locks.acquire("account-two");
  await second.release();
  await first.release();
});

test("two aliases for one account contend on one shared lock", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "snaapi-locks-")), ".locks");
  const locks = new AccountLock(directory);
  const first = await locks.acquire("same-account");
  await expect(locks.acquire("same-account")).rejects.toMatchObject({
    code: "CRYPTO_STATE_CONFLICT",
  });
  await first.release();
});
```

The integration test creates two dependency-injected `SnapchatClient`
instances with different account IDs and asserts both can remain open, while a
third client for the first account is rejected. Use fake runtime, messaging,
Gateway, and session dependencies; do not initialize official assets or make
network requests.

- [ ] **Step 2: Run lock/integration tests and verify RED where exports are missing**

Run: `npm test -- tests/session/account-lock.test.ts tests/integration/multi-account.test.ts --maxWorkers=1`

Expected: the lock primitives pass; the integration/import surface fails until
the profile resolver and types are exported.

- [ ] **Step 3: Export the supported library API**

Add to `src/index.ts`:

```ts
export { resolveAppConfig, type ResolveAppConfigOptions } from "./config.js";
export { AccountProfileStore, assertAccountAlias } from "./accounts/profile-store.js";
export type { AccountProfileRecord, AccountProfileSummary, AccountProfileV1 } from "./accounts/types.js";
```

Do not export internal parsing helpers or credential-bearing session values
beyond the existing API.

- [ ] **Step 4: Run lock/integration tests and verify GREEN**

Run: `npm test -- tests/session/account-lock.test.ts tests/integration/multi-account.test.ts --maxWorkers=1`

Expected: all tests PASS.

- [ ] **Step 5: Commit only Task 6 files**

```powershell
git add src/index.ts tests/integration/multi-account.test.ts tests/session/account-lock.test.ts
git commit -m "test: verify multi-account isolation"
```

---

### Task 7: Document onboarding, migration, and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/session-export-format.md`
- Test: `tests/package-bin.test.ts`

**Interfaces:**
- Consumes: final CLI behavior from Tasks 1-6.
- Produces: operator instructions for existing and new sealed sessions.

- [ ] **Step 1: Add a failing documentation contract test**

Extend `tests/package-bin.test.ts` to assert the README contains all of:

```ts
expect(readme).toContain("snaapi account add");
expect(readme).toContain("snaapi --account");
expect(readme).toContain("SNAAPI_ACCOUNT");
expect(readme).toContain("SNAAPI_ACCOUNTS_DIR");
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run: `npm test -- tests/package-bin.test.ts --maxWorkers=1`

Expected: FAIL because multi-account instructions are absent.

- [ ] **Step 3: Document the exact existing-session migration**

Add this operator flow to `README.md`:

```powershell
snaapi account add main `
  --session private/da4d-session.json `
  --asset-dir private/da4d-assets

snaapi --account main session check
snaapi --account main friends list --easy
```

Document per-shell default selection:

```powershell
$env:SNAAPI_ACCOUNT="main"
snaapi session check
```

Document new-account bootstrap without profile mode:

```powershell
$env:SNAP_BUILD_ID="da4d065e"
$env:SNAP_ASSET_DIR="C:\Users\eitab\Documents\js\snaapi\private\da4d-assets"
snaapi session export-cdp --har private\fresh-account.har --output private\account-session.json
snaapi account add second --session private\account-session.json --asset-dir private\da4d-assets
snaapi --account second session check
```

State clearly that HAR and session files are secrets, profiles are metadata,
and no live send is required to validate registration.

- [ ] **Step 4: Document profile/session invariants**

In `docs/session-export-format.md`, specify that each profile references exactly
one sealed session, account/build identity is derived from that session, and
selected-profile import/export refuses account, build, or destination mismatch.

- [ ] **Step 5: Run documentation and full verification**

Run in this exact order:

```powershell
npm test -- tests/package-bin.test.ts --maxWorkers=1
npm test -- --maxWorkers=1
npm run typecheck
npm run build
git diff --check
snaapi --version
snaapi account list
```

Expected:

- Documentation test PASS.
- Full suite has zero failed tests; existing explicit skips remain skips.
- Type checking and build exit `0`.
- `git diff --check` exits `0` apart from non-failing line-ending warnings.
- `snaapi --version` prints `0.1.0`.
- `snaapi account list` performs no network traffic and prints only non-secret profile summaries.

- [ ] **Step 6: Commit only Task 7 files**

```powershell
git add README.md docs/session-export-format.md tests/package-bin.test.ts
git commit -m "docs: explain multi-account profiles"
```

---

## Final Acceptance Checklist

- [ ] `snaapi --account main session check` resolves only `main`'s session and assets.
- [ ] `SNAAPI_ACCOUNT=main` behaves identically to the explicit flag.
- [ ] Explicit `--account bot` overrides `SNAAPI_ACCOUNT=main`.
- [ ] No selection preserves the existing four-variable `.env` workflow.
- [ ] Two distinct account IDs can run concurrently with separate Workers and session stores.
- [ ] Two aliases resolving to one account ID contend on one shared lock.
- [ ] Account management output contains no account IDs, tokens, Cookies, E2EE keys, or session contents.
- [ ] Profile-mode import/export cannot write another profile's session path.
- [ ] Existing `snap` and `snaapi` executable aliases both route profile commands.
- [ ] Full serial tests, typecheck, build, and diff check pass.
- [ ] No live Chat, Snap, login, OTP, CAPTCHA, or Gateway mutation was performed for acceptance.

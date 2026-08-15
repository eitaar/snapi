# Multi-Account Profiles Design

## Goal

Allow one local `snaapi` installation to operate multiple Snapchat accounts
without copying the repository or repeatedly rewriting `.env`. Account
selection must be explicit, session and E2EE state must remain isolated, and
the existing single-account environment-variable workflow must continue to
work unchanged.

## Command-line interface

An account profile is selected before the command:

```powershell
snaapi --account main friends list --easy
snaapi --account bot chat send <recipient-id> "hello" --conversation-id <conversation-id>
```

`SNAAPI_ACCOUNT` supplies a per-shell default when `--account` is omitted.
The explicit flag has higher precedence. If neither is present, the CLI uses
the existing `SNAP_SESSION_FILE`, `SNAP_ASSET_DIR`, `SNAP_ACCOUNT_ID`, and
`SNAP_BUILD_ID` environment variables. There is no persistent `account use`
command because hidden global account switching increases the risk of sending
from the wrong account.

The first version adds these management commands:

```powershell
snaapi account add main --session private/da4d-session.json --asset-dir private/da4d-assets
snaapi account list
snaapi account show main
```

`account add` reads the sealed session to derive its account ID and build ID,
verifies the matching assets, and writes only path metadata. It never copies
or prints credentials. Removing profiles is out of scope for the first
version; the profile JSON can be deleted manually after confirming no process
uses it.

## Storage model

Profiles live under `private/accounts` by default. `SNAAPI_ACCOUNTS_DIR` may
override that root.

```text
private/accounts/
├── .locks/
├── main.json
└── bot.json
```

Each profile has this versioned schema:

```json
{
  "formatVersion": 1,
  "sessionFile": "../da4d-session.json",
  "assetDir": "../da4d-assets"
}
```

Paths are stored relative to the profile file when possible and resolved to
absolute canonical paths when loaded. The profile does not duplicate the
account ID, build ID, Cookie, Bearer token, or E2EE key state. Account and
build identity come from the DPAPI-sealed session itself.

Aliases must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. This prevents path
traversal and keeps profile filenames predictable. Profile writes are atomic.

## Configuration resolution

Introduce one asynchronous resolver:

```ts
interface ResolveAppConfigOptions {
  readonly accountAlias?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

async function resolveAppConfig(
  options?: ResolveAppConfigOptions,
): Promise<AppConfig>;
```

For profile mode it loads the profile, decrypts and validates the selected
session, derives `accountId` and `buildId`, then applies only the existing
non-profile overrides `SNAP_OUTPUT`, `SNAP_COOKIE_HEADER`, and
`SNAP_SSO_COOKIE_HEADER`. For legacy mode it delegates to the existing
`loadConfig` behavior.

`AppConfig` gains a `lockDir` field. Profile mode uses the shared
`<accounts-dir>/.locks` directory, so two aliases pointing at the same account
still contend on the same `<accountId>.lock`. Legacy mode uses the existing
lock location beside the session file.

## CLI routing and library use

The CLI parses and removes the global `--account <alias>` prefix before normal
command routing. It resolves `AppConfig` once and injects that immutable value
into client, session, Gateway, and diagnostic command factories. Commands must
not mutate `process.env` to switch accounts.

The Node.js API remains naturally multi-account: callers create one
`SnapchatClient` per resolved profile.

```ts
const main = await SnapchatClient.create(await resolveAppConfig({ accountAlias: "main" }));
const bot = await SnapchatClient.create(await resolveAppConfig({ accountAlias: "bot" }));
```

Separate accounts may run concurrently. The same account remains single
writer because both clients acquire the shared account-ID lock. Each client
retains its own Worker, auth refresh timer, Gateway connection, session store,
and shutdown lifecycle.

## Session command safety

`session check`, `session refresh-har`, `session import`, and runtime/debug
commands operate only on the resolved profile session. Any account or build
mismatch fails before authenticated traffic or persistence.

`session export-cdp` keeps its existing explicit `--output` bootstrap flow.
After exporting a new account, the operator registers it with `account add`.
When `--account` is supplied to a later export or import, the destination must
equal that profile's session path and the resulting session must match the
existing profile account and supported build.

## Output and errors

Human `account list` output shows alias, build, and one of `ready`,
`missing-session`, or `invalid`. JSON output uses the same non-secret fields.
Account IDs, session contents, token values, Cookie values, E2EE keys, and raw
HAR values are never printed.

Invalid aliases, duplicate aliases, missing profiles, malformed profiles,
unreadable sealed sessions, asset mismatches, and attempts to bind a profile
to a different account fail with existing `INVALID_CONFIG`,
`INVALID_SESSION_EXPORT`, or `UNSUPPORTED_BUILD` errors as appropriate.

## Compatibility and migration

No automatic migration is performed. Existing `.env` users continue using
the CLI without `--account`. To register the current account, they run
`snaapi account add` against the existing sealed session and asset directory.
Both `snap` and `snaapi` command aliases support profiles.

## Testing

Tests cover alias validation, path resolution, atomic profile writes, sealed
session-derived identity, CLI precedence, argument stripping, legacy fallback,
same-account lock contention across aliases, distinct-account concurrency,
all affected command factories, redacted output, and profile-aware session
guards. Existing full serial tests, type checking, build, and offline session
checks remain required. No live Chat or Snap send is part of this feature's
automated acceptance test.

## Non-goals

- Browser login, OTP, CAPTCHA, or DBSC automation
- Sharing authentication or E2EE state between accounts
- Automatic profile deletion
- Running multiple commands for one account in parallel
- Relaxing build, asset-hash, session-account, or HAR validation

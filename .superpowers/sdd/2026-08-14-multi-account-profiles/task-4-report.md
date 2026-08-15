Task 4 report

Summary:
- Added offline `snaapi account add`, `snaapi account list`, and `snaapi account show` command modules.
- Routed `account` commands in `src/cli/index.ts` before profile config resolution.
- Kept output redacted to alias/build/status plus non-secret paths for `account show`.
- Fixed account management routing so an invalid `SNAAPI_ACCOUNT` cannot block `account add`, `account list`, or `account show`.
- Fixed account management routing with both direct and explicit `--account` prefixes, without changing validation for client-backed commands.
- Mapped an `ENOENT` session-load race to `missing-session` while retaining `invalid` for other load failures.
- Verified focused Task 4 tests and project typecheck without live Snapchat requests.

Files changed:
- `src/cli/commands/account-add.ts`
- `src/cli/commands/account-list.ts`
- `src/cli/commands/account-show.ts`
- `src/cli/index.ts` (Task 4 routing hunks only in commit)
- `tests/cli/account-commands.test.ts`

Tests and verification:
- `npm test -- tests/cli/account-commands.test.ts --maxWorkers=1` (RED: failed because account command modules were missing)
- `npm test -- tests/cli/account-commands.test.ts tests/cli/commands.test.ts --maxWorkers=1` (RED for the two review regressions: 45 passed, 2 failed)
- `npm test -- tests/cli/account-commands.test.ts tests/cli/commands.test.ts --maxWorkers=1` (PASS: 47 tests)
- `npm run typecheck` (PASS)
- `npm test -- tests/cli/account-commands.test.ts tests/cli/commands.test.ts --maxWorkers=1` (RED for invalid explicit `--account`: 48 passed, 1 failed)
- `npm test -- tests/cli/account-commands.test.ts tests/cli/commands.test.ts --maxWorkers=1` (PASS: 49 tests)
- `npm run typecheck` (PASS)

Commits:
- `dd08673bbdcaa6c2c320e23647301e6ee4055434` — `feat: manage local account profiles`
- `89649f90aaffbb345e23b23cd7620d2a8107f9ae` — `fix: keep account management independent`
- `1821dc688b6c51e4fcd404ce423f59fd5208f1a1` — `fix: bypass account selection for management commands`

Caveats:
- No live Snapchat requests, login, send, or secret file changes were performed.
- The checkout still has unrelated pre-existing dirty changes outside these Task 4 commits; `src/cli/index.ts` remains modified in the working tree after the commits because those unrelated edits were intentionally preserved.

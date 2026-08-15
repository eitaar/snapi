Task 4 report

Summary:
- Added offline `snaapi account add`, `snaapi account list`, and `snaapi account show` command modules.
- Routed `account` commands in `src/cli/index.ts` before profile config resolution.
- Kept output redacted to alias/build/status plus non-secret paths for `account show`.
- Verified focused Task 4 tests and project typecheck without live Snapchat requests.

Files changed:
- `src/cli/commands/account-add.ts`
- `src/cli/commands/account-list.ts`
- `src/cli/commands/account-show.ts`
- `src/cli/index.ts` (Task 4 routing hunks only in commit)
- `tests/cli/account-commands.test.ts`

Tests and verification:
- `npm test -- tests/cli/account-commands.test.ts --maxWorkers=1` (RED: failed because account command modules were missing)
- `npm test -- tests/cli/account-commands.test.ts tests/cli/commands.test.ts --maxWorkers=1` (PASS)
- `npm run typecheck` (PASS)

Commit:
- `dc71b7b895a2aa34ec97a0867bffba6990cc5473`
- Message: `feat: manage local account profiles`

Caveats:
- No live Snapchat requests, login, send, or secret file changes were performed.
- The checkout still has unrelated pre-existing dirty changes outside this Task 4 commit; `src/cli/index.ts` remains modified in the working tree after the commit because those unrelated edits were intentionally preserved.

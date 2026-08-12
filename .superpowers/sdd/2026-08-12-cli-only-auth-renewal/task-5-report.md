# Task 5 Report: Add the CLI-only auth renewal feasibility probe

## Summary

Implemented the bounded Task 5 diagnostic surface for:

```powershell
node dist/cli/index.js debug auth-renewal --cli-only
```

The new probe is opt-in, requires `SNAP_LIVE_TESTS=1`, performs only the permitted CLI-only renewal attempt plus a single read-only verification request, classifies browser-bound outcomes safely, and does not print or persist raw Cookie/Bearer/token/proof/body material.

This pass also updated the bounded Task 5 documentation in `README.md` and
`docs/runtime-feasibility-report.md` without overwriting unrelated dirty
changes.

## Files changed in this pass

- `src/diagnostics/cli-auth-renewal.ts`
- `tests/diagnostics/cli-auth-renewal.test.ts`
- `src/cli/index.ts`
- `src/cli/commands/debug-doctor.ts`
- `README.md`
- `docs/runtime-feasibility-report.md`
- `.superpowers/sdd/2026-08-12-cli-only-auth-renewal/task-5-report.md`

## Scope kept bounded

- Did not stage files
- Did not create a commit
- Preserved unrelated dirty user changes

## RED evidence

Initial focused command:

```powershell
npm test -- tests/diagnostics/cli-auth-renewal.test.ts
```

Initial RED result:

- suite failed because `src/diagnostics/cli-auth-renewal.ts` did not exist
- Vitest reported:
  - `Cannot find module '../../src/diagnostics/cli-auth-renewal.js'`

After adding the module, the next focused RED exposed the remaining Task 5 gaps:

- rejected verification after a successful refresh returned the wrong capability status
  - expected `manual-session used`
  - received `manual-session unavailable`
- `debug auth-renewal --cli-only` was not wired into `main`
  - command returned usage exit `2` instead of the expected live-gated behavior
- the injected `runDebugAuthRenewal` dependency was not being called by the CLI routing test
- after wiring, one additional RED remained:
  - the `SNAP_LIVE_TESTS=1` gate was reading the real process environment instead of the injected test environment

## GREEN evidence

Final focused command:

```powershell
npm test -- tests/diagnostics/cli-auth-renewal.test.ts
```

Passing result:

- `Test Files  1 passed (1)`
- `Tests  6 passed (6)`
- exit code `0`

## Behavior implemented

### Diagnostic module

Added `src/diagnostics/cli-auth-renewal.ts` with:

- `CliAuthRenewalReport`
- `runCliAuthRenewalProbe()`

The probe:

- loads the configured session/config
- applies configured cookie overrides safely
- attempts a single CLI-only SSO renewal
- performs at most one read-only verification request
- never writes session state
- returns only safe result/status/capability metadata

### Safe outcome mapping

Covered all requested report results:

- `renewed`
- `browser-context-required`
- `profile-unavailable`
- `rejected`

Implemented the required correction that when refresh succeeds but the single verification request still fails, the report stays:

```text
manual-session used
```

instead of incorrectly reporting that capability as unavailable.

### Live gate and CLI wiring

Wired:

```powershell
node dist/cli/index.js debug auth-renewal --cli-only
```

through:

- `src/cli/index.ts`
- `src/cli/commands/debug-doctor.ts`

Behavior:

- requires `SNAP_LIVE_TESTS=1`
- uses safe `emitError` handling through the existing CLI error path
- honors the injected `runDebugAuthRenewal` dependency in tests
- forwards injected `env` into the default command path so tests do not accidentally read the real process environment

## Test coverage added

`tests/diagnostics/cli-auth-renewal.test.ts` covers:

- `renewed`
- `browser-context-required`
- `profile-unavailable`
- `rejected`
- `SNAP_LIVE_TESTS=1` gate
- CLI routing through `debug auth-renewal --cli-only`

The tests also assert that serialized output does not contain raw:

- Cookie values
- Bearer/token values
- attestation proof values
- DBSC proof/profile values
- probe request body material

## Safety notes

- no live Snapchat calls are made by normal tests
- no session persistence occurs on probe failure
- the verification step uses one read-only request only
- the diagnostic surface never emits raw secret-bearing values in the report contract or test assertions

## Documentation updates

### `README.md`

Added the opt-in diagnostic command:

```powershell
$env:SNAP_LIVE_TESTS='1'; node dist/cli/index.js debug auth-renewal --cli-only
```

and documented that it:

- is opt-in and read-only
- requires `SNAP_LIVE_TESTS=1`
- performs at most one renewal attempt plus one read-only verification request
- classifies `renewed`, `browser-context-required`, `profile-unavailable`, and `rejected`
- does not print or persist raw Cookie/Bearer/token/proof/body material

### `docs/runtime-feasibility-report.md`

Added a separate interpretation section for the CLI-only auth renewal
diagnostic gate, including:

- `renewed` means only that the current diagnostic execution's single refresh
  and single verification both succeeded
- `browser-context-required` means the flow hit the expected browser-bound
  `303`/`403` class of outcomes
- `profile-unavailable` means the local Brave/DBSC profile state was not
  available to the process
- `rejected` means the CLI-only path ran but the single verification request
  still failed

## Concerns / follow-up notes

- `src/cli/index.ts` already has unrelated dirty Snap/Friends changes in the worktree, so staging/commit for Task 5 should be done carefully and selectively
- `README.md` and `docs/runtime-feasibility-report.md` already contained unrelated dirty changes, so the Task 5 documentation updates were added in isolated locations rather than rewriting existing sections
- the Task 5 report is complete, but the final Task 5 commit is still pending because the requested no-stage/no-commit constraint takes precedence for this turn

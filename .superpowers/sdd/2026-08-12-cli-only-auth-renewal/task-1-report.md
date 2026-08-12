# Task 1 report

## Implementation

Added the safe CLI-only renewal contract in `src/auth/renewal.ts` and the focused classifier tests in `tests/auth/renewal.test.ts`. The classifier preserves only the allowed AppError code, numeric HTTP status, safe redirect metadata, and sanitized renewal observations; it does not copy the original error details or message into the returned error.

## Tests

The implementer subagent was blocked during the initial file-creation/report step and did not provide RED evidence. The files were present after the subagent stopped, so the parent verified the GREEN path directly:

```text
npm test -- tests/auth/renewal.test.ts
1 test file passed; 5 tests passed.
```

The tests cover redirect/browser-context classification, unavailable DBSC profile, SSO 403, malformed token, and unknown errors, including forbidden credential-like strings.

## Files changed

- `src/auth/renewal.ts`
- `tests/auth/renewal.test.ts`

## Self-review / concerns

No source changes were made to `src/errors.ts`; existing error codes were sufficient. Parent verification was required because the subagent did not write its report before stopping.

## Fix round 1

The classifier now uses only numeric status, AppError code, safe redirect metadata, and two explicit structured reason values. It no longer parses free-form error messages. The renewal contract also exposes type-only inputs for `SessionExport`, `DbscRefreshResult`, and `SsoRefreshDependencies`.

Verification:

```text
npm test -- tests/auth/renewal.test.ts
1 test file passed; 6 tests passed.
```

# Messaging initialization error diagnosis and repair

## Goal

Replace the misleading `SESSION_REEXPORT_REQUIRED` result emitted after an
official Messaging Worker initialization failure with the original safe error,
then use that error to identify and repair any local implementation defect.

## Current behavior

The persisted session contains `messaging.rootWrappingKey` and friend-device
state. During Worker startup, `initializeMessagingSession` can fail while
creating the official duplex client. `worker-entry.ts` currently treats selected
Messaging failures as non-fatal and continues without an
`officialConversationManager`. A later Chat or Snap operation sees only the
missing manager and incorrectly reports that login-time messaging state was not
exported.

## Design

The Worker will retain a sanitized `AppError` when Messaging initialization is
allowed to fail without aborting general runtime startup. Operations that need
the conversation manager will use one shared guard:

1. Return the manager when initialization succeeded.
2. Re-throw the retained initialization error when initialization failed.
3. Emit `SESSION_REEXPORT_REQUIRED` only when the input session genuinely had no
   `messaging` state.

The retained error must contain only the existing redacted error contract. It
must not include Cookie, Bearer, DBSC, attestation, or protobuf payload values.
Successful reinitialization or shutdown clears the retained failure.

## Diagnosis flow

After the regression test and error-propagation change pass offline tests, run a
read-only live operation that initializes Messaging. Use its safe error code,
message, stage, HTTP status, and endpoint path to distinguish:

- local state/serialization defects;
- official Worker API contract defects;
- expired authentication;
- browser-bound Gateway or duplex authorization.

Only a confirmed local defect is repaired in this change. Browser fingerprint,
attestation, device-key, DBSC, or TLS-binding bypasses are out of scope.

## Tests

Add focused Worker tests proving that:

- an allowed Messaging initialization failure is returned unchanged by a later
  Chat or Snap operation;
- a session with no `messaging` state still receives the existing re-export
  error;
- successful initialization does not retain a stale failure.

Then run the focused test, full serial suite, typecheck, build, and a read-only
live Messaging command. No message or Snap is sent during diagnosis.

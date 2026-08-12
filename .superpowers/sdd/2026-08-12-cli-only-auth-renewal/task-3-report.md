# Task 3 report

## Implementation

Added explicit request replay policy handling for gRPC-Web operations:

- read-only and idempotent calls may refresh once and retry once after HTTP 401/403 or gRPC 7/16;
- ambiguous message/Snap sends do not refresh or replay after either HTTP or gRPC authentication failure;
- existing `AuthProvider` single-flight behavior and old-session preservation remain intact;
- messaging and media call sites label their replay policy explicitly.
- ambiguous gRPC 7/16 failures are normalized to `DELIVERY_UNCONFIRMED` by both chat and photo-Snap send clients.

## Verification

```text
npm test -- tests/transport/auth-provider.test.ts tests/transport/grpc-client.test.ts tests/messaging/client.test.ts tests/media/client.test.ts tests/media/official-upload.test.ts
5 test files passed; 29 tests passed.
```

No live Snapchat request was made and no credential values were printed.

## Files changed

- `src/transport/grpc-client.ts`
- `src/messaging/client.ts`
- `src/media/official-upload.ts`
- `src/media/client.ts`
- `tests/transport/auth-provider.test.ts`
- `tests/transport/grpc-client.test.ts`
- `tests/messaging/client.test.ts`
- `tests/media/official-upload.test.ts`
- `tests/media/client.test.ts`

The first implementer stopped after producing a partial commit in an isolated preserve-user-edits snapshot; the parent completed the missing gRPC policy guard and regression test before verification.

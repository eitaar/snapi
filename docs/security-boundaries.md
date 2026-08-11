# Security boundaries

- Use only accounts, recipients, and conversations controlled by the operator.
- Login, passwords, 2FA, recovery, attestation bypass, and rate-limit bypass are
  outside scope.
- Unknown builds, asset hashes, module shapes, or WASM shapes stop before
  authenticated traffic.
- One process owns writable cryptographic state for an account. State changes
  use an atomic next/previous file rotation.
- Authentication values, cookies, Gateway subprotocol tokens, signed upload
  URLs, media keys, IVs, plaintext diagnostics, and image bytes must not be
  logged or committed.
- Photo bytes are encrypted before CDN upload. A failed upload prevents message
  creation. Ambiguous final sends are reported and are not automatically
  repeated.
- Incoming plaintext is emitted only by the explicit `chat watch` command and
  only after the official runtime state has been atomically persisted. Unknown
  or malformed protected content is not exposed.
- `.env`, `private/`, HARs, assets, raw payloads, images, logs, build output, and
  coverage output remain ignored by Git.

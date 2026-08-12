# Security boundaries

- Use only accounts, recipients, and conversations controlled by the operator.
- Login, passwords, 2FA, recovery, attestation bypass, and rate-limit bypass are
  outside scope. The supported refresh path may execute Snapchat's official Web
  Attestation WASM, but it never extracts or fabricates browser-managed session
  private keys.
- Unknown builds, asset hashes, module shapes, or WASM shapes stop before
  authenticated traffic.
- One process owns writable cryptographic state for an account. State changes
  use an atomic next/previous file rotation.
- Authentication values, cookies, Gateway subprotocol tokens, signed upload
  URLs, media keys, IVs, plaintext diagnostics, and image bytes must not be
  logged or committed.
- The CLI may import Chromium's OS-wrapped DBSC key into Windows CNG only for
  challenge signing. It never exports the private key or prints the wrapped
  blob, signature, challenge, or proof. DBSC use is limited to the configured
  Brave profile and the current Windows user; a locked or mismatched profile
  fails closed.
- For the same profile, the CLI may unwrap Brave's cookie master key with
  Windows DPAPI and decrypt legacy v10/v11 Snapchat cookies in memory only. It
  never writes or logs the master key or cookie values. v20 App-Bound cookies
  are not bypassed; they fail closed unless the Brave browser context is used.
  - Photo bytes are encrypted before CDN upload. A failed upload prevents message
    creation. Ambiguous final sends are reported and are not automatically
    repeated.
    - Friend synchronization exposes only public relationship metadata. Fidelius
      device records and all key material are removed at the official Worker
      boundary; this phase does not send, accept, delete, or block friend
      requests.
    - Incoming text is emitted only by the explicit `chat watch` command and
      incoming Snap media is resolved only while an explicit `snap watch`
      subscription is active. Media downloads use the runtime network guard;
      message, media-reference, pending-queue, resolved-layer, and byte work is
      bounded before media is written to the selected output directory. Runtime
      state is persisted before emission. Media bytes are not logged or printed.
      Unknown or malformed protected content is not exposed.
- Live diagnostics are bound to the configured session, account, and build.
  The auth-renewal verification fixture must also match the configured session
  export epoch and remain beside the ignored session file; unbound or stale
  fixtures are rejected before network traffic.
- `.env`, `private/`, HARs, assets, raw payloads, images, logs, build output, and
  coverage output remain ignored by Git.

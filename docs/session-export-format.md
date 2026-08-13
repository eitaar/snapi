# Session export format

## At-rest storage

The CLI writes the current session as a DPAPI-sealed JSON envelope:

```json
{
  "kind": "snapchat-sealed-session",
  "version": 1,
  "ciphertext": "<base64 ciphertext>"
}
```

The bearer token, Cookie headers, nonce state, and messaging state are inside
the ciphertext. The envelope contains no session metadata that is needed for
request construction. Decryption uses the current Windows user's DPAPI
context; another Windows user cannot use the file.

Legacy format-version-1 JSON exports remain readable for migration. Import,
HAR refresh, or the first client/gateway startup that explicitly migrates the
file writes the sealed envelope atomically and removes the plaintext
`.previous` backup after verification.

The CLI accepts a JSON session export with `formatVersion: 1`. The export is a
secret: it contains authentication credentials and end-to-end-encryption key
state. Store it under `private/` (ignored by Git), restrict access to the
operator account, and never paste it into logs or issue reports.

The capture mechanism is intentionally outside this repository. It must run in
an operator-controlled, freshly authenticated Snapchat Web page and serialize
the fields below without changing their values.

## Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | literal `1` | Export schema version. |
| `accountId` | string | Current Snapchat user UUID. Messaging initialization requires UUID form. |
| `buildId` | literal `8dd50222` | Exact supported Snapchat Web build. |
| `exportedAt` | string | ISO-8601 UTC timestamp such as `2026-08-10T00:00:00.000Z`. |
| `auth` | object | Authentication values described below. |
| `assets` | array | Exact local bundle manifest described below. |
| `localStorage` | object of strings | Complete storage snapshot required by the selected build. |
| `sessionStorage` | object of strings | Complete tab-scoped storage snapshot. Required for first messaging initialization. |
| `messaging` | object | E2EE bootstrap or resumed-session state. |
| `indexedDb` | object | IndexedDB snapshot described below. |

## Authentication

`auth` contains non-empty strings `httpToken`, `gatewayToken`, and
`cookieHeader`, plus `requestHeaders`, an object whose values are strings.
Header names are preserved exactly. In particular, keep the observed
`mcs-cof-ids-bin` value when present. For build `8dd50222`, `httpToken` and
`gatewayToken` are compatibility fields for the same shared auth token and
must contain the same value.

For login-epoch validation, `auth.ssoCookieHeader` contains the most recent
accounts-domain Cookie state: the Cookie header from the selected
`https://accounts.snapchat.com/accounts/sso` request merged with that response's
`Set-Cookie` values. `auth.ssoScuid` records the successful initial request's
`scuid` for diagnostics; established-session periodic refresh does not resend
it. The successful response's separate `scuid` must match the session account
ID. These values are accounts-domain credentials and are
distinct from the Web origin cookie and the session `accountId`.
`auth.ssoUsesDbsc` records whether that captured SSO request sent observed DBSC
cookies. `auth.ssoRequestHeaders` stores a restricted, non-secret allowlist for
token renewal.
`auth.webSessionRequestHeaders` stores the restricted browser headers observed
on a successful `POST /web-chat-session/refresh` request.
`auth.tokenRefreshedAt` and `auth.webSessionRefreshedAt` independently record
the HTTP and Web-session renewal clocks. `auth.gatewayTokenCapturedAt` records
when a browser capture last proved that shared token in a successful Gateway
`101` handshake. SSO renewal updates the shared token but does not rewrite this
browser-observation timestamp.

Automatic token renewal runs the pinned official Web Attestation WASM and posts
the proof with `auth.ssoCookieHeader` to `accounts/sso`. A successful response
replaces both compatibility token fields. This matches the pinned browser
bundle, whose Messaging and Gateway paths call the same auth-token getter, and
the accepted HAR requires the successful Messaging and Gateway requests to use
that same value. While a client remains open, the CLI drives this renewal on
the ten-minute freshness schedule and pushes the result into the official
Worker before its next reconnect. The CLI separately repeats the hourly
Web-session heartbeat with the current shared token and `cookieHeader`. A
successful empty response preserves the token, merges any response `Set-Cookie`
values into the Web cookie, and advances the heartbeat clock. A rejected
renewal requires a fresh login HAR.

Use `snap session refresh-har <fresh.har>` to extract and persist these values
as one atomic operation.

All four fields are credentials. The CLI must never print their values.

## Messaging key lifecycle

There are two valid capture states.

### First initialization after login

Capture all of the following before the browser removes the login query data:

- `messaging.keyInitializationInfo`: canonical Base64 of the bytes returned in
  `transaction_data.dwebData.data` by the SSO redirect.
- `sessionStorage.e2eeTempKey`: the opaque JSON string generated by the
  Snapchat Web key manager before it redirects to SSO. Do not parse, re-encode,
  or reconstruct it.
- `messaging.friendDevices`: a map from lowercase user UUIDs to the complete
  Fidelius device objects returned for those users. An empty map is valid only
  when no recipient lookup will be attempted.

The temporary key and initialization response are a pair. Capturing only one
cannot initialize the current-user key. On success, the official key manager
replaces the temporary state with a persisted root wrapping key.

### Resumed initialized session

Capture the current `localStorage` and `sessionStorage`, and include:

```json
{
  "messaging": {
    "rootWrappingKey": {
      "data": "<canonical Base64>",
      "identityKeyId": "<canonical Base64>"
    },
    "friendDevices": {}
  }
}
```

`keyInitializationInfo` is optional after successful key initialization.
`rootWrappingKey` is optional only in the first-initialization form, where
`keyInitializationInfo` and `sessionStorage.e2eeTempKey` are both present.

The runtime exports updated `localStorage`, `sessionStorage`,
`rootWrappingKey`, and IndexedDB state after successful cryptographic work.
Those values must be merged atomically into the operator's session file before
the next process starts.

## Base64 encoding

Binary fields use canonical RFC 4648 Base64 with the standard `+` and `/`
alphabet and required `=` padding. Base64url is not accepted. Values must be
non-empty and must decode without ignored characters or whitespace.

## Asset manifest

Each item in `assets` has:

```json
{
  "kind": "javascript",
  "filename": "bundle.js",
  "sha256": "<64 lowercase hexadecimal characters>",
  "size": 123
}
```

`kind` is `javascript` or `wasm`; `filename` is the basename under
`SNAP_ASSET_DIR`; `sha256` is the digest of the exact bytes; and `size` is a
positive integer. The manifest must match the pinned build before any
authenticated request is allowed.

## IndexedDB snapshot

`indexedDb.databases` is an array. Each database contains `name`, positive
integer `version`, and `stores`. Each store contains:

- `name`
- `keyPath`: string, non-empty string array, or `null`
- `autoIncrement`: boolean
- `indexes`: objects with `name`, string or string-array `keyPath`, `unique`,
  and `multiEntry`
- `records`: objects with both `key` and `value`

Record keys and values must be structured-clone-compatible. Binary values must
use the exact tagged form `{"$bytes":"<canonical Base64>"}`. The loader
recursively restores an object with only that property to `Uint8Array`, and the
atomic state store emits the same form. An object containing `$bytes` plus any
other property remains an ordinary object. A plain JSON number array and the
default `{"0":1,"1":2}` result of stringifying `Uint8Array` are invalid
substitutes because they do not preserve the byte type.

## Minimal structural example

This example is deliberately non-functional and contains no real credentials:

```json
{
  "formatVersion": 1,
  "accountId": "11111111-1111-4111-8111-111111111111",
  "buildId": "8dd50222",
  "exportedAt": "2026-08-10T00:00:00.000Z",
  "auth": {
    "httpToken": "REDACTED",
    "gatewayToken": "REDACTED",
    "cookieHeader": "REDACTED",
    "ssoCookieHeader": "REDACTED",
    "ssoScuid": "11111111-1111-4111-8111-111111111111",
    "requestHeaders": {}
  },
  "assets": [],
  "localStorage": {},
  "sessionStorage": {
    "e2eeTempKey": "OPAQUE_CAPTURED_VALUE"
  },
  "messaging": {
    "keyInitializationInfo": "AQID",
    "friendDevices": {}
  },
  "indexedDb": {
    "databases": []
  }
}
```

## Forbidden repository content

Do not commit `.env`, `private/`, session exports, raw HAR files, WebSocket
payloads, bundle or WASM files, image test inputs, signed upload URLs, cookies,
tokens, temporary keys, root wrapping keys, or raw friend-device key records.

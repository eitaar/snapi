const SECRET_KEY = /authorization|cookie|token|signature|signed.?url|crypto.?state|image.?bytes|plaintext/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "<REDACTED>" : redact(entry),
      ]),
    );
  }
  return value;
}

const BYTE_TAG = "$bytes";

function canonicalBase64(value: unknown): value is string {
  return typeof value === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value;
}

function byteReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BYTE_TAG]: Buffer.from(value).toString("base64") };
  }
  if (value instanceof ArrayBuffer) {
    return { [BYTE_TAG]: Buffer.from(value).toString("base64") };
  }
  return value;
}

function byteReviver(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== BYTE_TAG) return value;
  if (!canonicalBase64(record[BYTE_TAG])) {
    throw new TypeError("Binary JSON byte tag must contain canonical Base64");
  }
  return new Uint8Array(Buffer.from(record[BYTE_TAG], "base64"));
}

export function stringifyJsonWithBytes(value: unknown, space?: number): string {
  const text = JSON.stringify(value, byteReplacer, space);
  if (text === undefined) throw new TypeError("Value is not JSON serializable");
  return text;
}

export function parseJsonWithBytes(text: string): unknown {
  return JSON.parse(text, byteReviver) as unknown;
}

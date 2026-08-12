import { describe, expect, it, vi } from "vitest";
import {
  parseDbscChallenge,
  parseDbscSessionProto,
  refreshBraveDbsc,
  resolveOptionalBraveProfileDir,
  type DbscSigner,
  type StoredDbscSession,
} from "../../src/auth/dbsc.js";

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

function field(number: number, value: Uint8Array): Uint8Array {
  const tag = varint(number << 3 | 2);
  return Uint8Array.from([...tag, ...varint(value.length), ...value]);
}

function message(...fields: Uint8Array[]): Uint8Array {
  return Uint8Array.from(fields.flatMap((value) => [...value]));
}

function storedSession(): StoredDbscSession {
  return {
    sessionId: "dbsc-session-id",
    refreshUrl: "https://accounts.snapchat.com/accounts/dbsc/refresh",
    wrappedKey: Uint8Array.from([1, 2, 3, 4]),
  };
}

describe("DBSC auth", () => {
  it("resolves the configured Brave profile directory without throwing when unavailable", () => {
    expect(resolveOptionalBraveProfileDir({
      SNAP_BRAVE_PROFILE_DIR: "C:\\Users\\eitab\\Brave\\Profile 7",
    } as NodeJS.ProcessEnv)).toBe("C:\\Users\\eitab\\Brave\\Profile 7");

    expect(resolveOptionalBraveProfileDir({
      SNAP_BRAVE_PROFILE_DIR: "   ",
      LOCALAPPDATA: "   ",
    } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("extracts the session id, refresh URL, and wrapped key from Chromium's protobuf row", () => {
    const proto = message(field(1, message(
      field(1, new TextEncoder().encode("dbsc-session-id")),
      field(2, message(
        field(2, new TextEncoder().encode("https://accounts.snapchat.com/accounts/dbsc/refresh")),
        field(5, Uint8Array.from([1, 2, 3, 4])),
      )),
    )));

    expect(parseDbscSessionProto(proto)).toEqual(storedSession());
  });

  it("extracts the challenge value from the structured DBSC challenge header", () => {
    expect(parseDbscChallenge('"challenge-value";id="opaque-id"')).toBe("challenge-value");
  });

  it("signs the challenge, refreshes DBSC, and merges rotated cookies", async () => {
    const signer: DbscSigner = {
      algorithm: "RS256",
      sign: vi.fn(async () => new Uint8Array(256).fill(7)),
    };
    const openSession = vi.fn(async () => storedSession());
    const createSigner = vi.fn(async () => signer);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 403,
        headers: { "secure-session-challenge": '"challenge-value";id="opaque-id"' },
      }))
      .mockResolvedValueOnce(new Response('{"continue":false}', {
        status: 200,
        headers: { "set-cookie": "rotated=value; Path=/" },
      }));

    const result = await refreshBraveDbsc("first=one", {
      fetch,
      openSession,
      createSigner,
    });

    expect(result.cookieHeader).toBe("first=one; rotated=value");
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, init] = fetch.mock.calls[1]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("sec-secure-session-id")).toBe('"dbsc-session-id"');
    expect(headers.get("secure-session-response")).toMatch(/^"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"$/);
    expect(headers.get("cookie")).toBe("first=one");
    expect(signer.sign).toHaveBeenCalledOnce();
  });
});

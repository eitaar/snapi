import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildBraveCookieHeader,
  decryptChromiumCookieValue,
  readBraveCookieHeader,
  type BraveCookieRecord,
} from "../../src/auth/brave-cookies.js";

describe("Brave cookie auth", () => {
  it("prefers the most specific domain when duplicate cookie names exist", () => {
    const records: BraveCookieRecord[] = [
      { hostKey: ".snapchat.com", name: "_sc-sid", value: "parent", encryptedValue: new Uint8Array(), path: "/" },
      { hostKey: ".accounts.snapchat.com", name: "_sc-sid", value: "domain", encryptedValue: new Uint8Array(), path: "/" },
      { hostKey: "accounts.snapchat.com", name: "_sc-sid", value: "host", encryptedValue: new Uint8Array(), path: "/" },
      { hostKey: ".accounts.snapchat.com", name: "sc-a-dbsc-session", value: "dbsc", encryptedValue: new Uint8Array(), path: "/" },
    ];

    expect(buildBraveCookieHeader(records)).toBe("_sc-sid=host; sc-a-dbsc-session=dbsc");
  });

  it("decrypts Chromium v10 AES-GCM cookie values", () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update("cookie-secret", "utf8"), cipher.final()]);
    const stored = Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()]);

    expect(decryptChromiumCookieValue(stored, key)).toBe("cookie-secret");
  });

  it("fails closed for Chromium v20 App-Bound cookies", () => {
    expect(() => decryptChromiumCookieValue(Buffer.from("v20app-bound"), randomBytes(32))).toThrow(
      "Brave v20 cookies require the Brave browser context",
    );
  });

  it("does not attempt v20 decryption from the Brave profile store", async () => {
    const root = await mkdtemp(join(tmpdir(), "snaapi-brave-cookie-v20-"));
    try {
      const profileDir = join(root, "Default");
      await mkdir(join(profileDir, "Network"), { recursive: true });

      const database = new DatabaseSync(join(profileDir, "Network", "Cookies"));
      database.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT)");
      const insert = database.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value, path) VALUES (?, ?, ?, ?, ?)");
      insert.run("accounts.snapchat.com", "__Host-sc-a-auth-session", "", Buffer.from("v20app-bound"), "/");
      insert.run(".accounts.snapchat.com", "sc-a-dbsc-session", "dbsc", new Uint8Array(), "/");
      database.close();

      const unprotect = vi.fn(async () => randomBytes(32));

      await expect(readBraveCookieHeader(profileDir, { unprotect })).rejects.toMatchObject({
        code: "AUTH_CONTEXT_UNAVAILABLE",
        message: "Brave v20 cookies require the Brave browser context for App-Bound decryption",
      });
      expect(unprotect).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads and decrypts the current cookie store without persisting the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "snaapi-brave-cookie-"));
    try {
      const userDataDir = join(root, "User Data");
      const profileDir = join(userDataDir, "Default");
      await mkdir(join(profileDir, "Network"), { recursive: true });
      const masterKey = randomBytes(32);
      await writeFile(join(userDataDir, "Local State"), JSON.stringify({
        os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), Buffer.from("wrapped-key")]).toString("base64") },
      }));

      const database = new DatabaseSync(join(profileDir, "Network", "Cookies"));
      database.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT)");
      const insert = database.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value, path) VALUES (?, ?, ?, ?, ?)");
      const encrypt = (value: string): Buffer => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()]);
      };
      insert.run("accounts.snapchat.com", "__Host-sc-a-auth-session", "", encrypt("auth"), "/");
      insert.run(".accounts.snapchat.com", "sc-a-dbsc-session", "", encrypt("dbsc"), "/");
      database.close();

      const unprotect = vi.fn(async (value: Uint8Array) => {
        expect(Buffer.from(value).toString("utf8")).toBe("wrapped-key");
        return masterKey;
      });
      await expect(readBraveCookieHeader(profileDir, { unprotect })).resolves.toBe(
        "__Host-sc-a-auth-session=auth; sc-a-dbsc-session=dbsc",
      );
      expect(unprotect).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

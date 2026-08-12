import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { AppError } from "../errors.js";
import { resolveBraveProfileDir } from "./dbsc.js";

const ACCOUNTS_HOST = "accounts.snapchat.com";
const COOKIE_DOMAINS = ["accounts.snapchat.com", ".accounts.snapchat.com", ".snapchat.com"] as const;
const POWERSHELL_ENV = "SNAP_POWERSHELL";

export interface BraveCookieRecord {
  readonly hostKey: string;
  readonly name: string;
  readonly value: string;
  readonly encryptedValue: Uint8Array;
  readonly path: string;
}

export interface BraveCookieDependencies {
  readonly unprotect?: (value: Uint8Array) => Promise<Uint8Array>;
}

function domainRank(hostKey: string): number {
  const normalized = hostKey.toLowerCase().replace(/^\./, "");
  if (normalized !== ACCOUNTS_HOST && normalized !== "snapchat.com") return Number.POSITIVE_INFINITY;
  if (normalized === ACCOUNTS_HOST && !hostKey.startsWith(".")) return 0;
  if (normalized === ACCOUNTS_HOST) return 1;
  return 2;
}

export function buildBraveCookieHeader(records: readonly BraveCookieRecord[]): string {
  const selected = new Map<string, { readonly record: BraveCookieRecord; readonly index: number }>();
  records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => domainRank(record.hostKey) !== Number.POSITIVE_INFINITY && record.value !== "")
    .sort((left, right) => {
      const rankDifference = domainRank(left.record.hostKey) - domainRank(right.record.hostKey);
      if (rankDifference !== 0) return rankDifference;
      const pathDifference = right.record.path.length - left.record.path.length;
      return pathDifference !== 0 ? pathDifference : left.index - right.index;
    })
    .forEach((entry) => {
      if (!selected.has(entry.record.name)) selected.set(entry.record.name, entry);
    });
  return [...selected.values()].map(({ record }) => `${record.name}=${record.value}`).join("; ");
}

export function decryptChromiumCookieValue(encryptedValue: Uint8Array, masterKey: Uint8Array): string {
  const prefix = Buffer.from(encryptedValue.subarray(0, 3)).toString("ascii");
  if (prefix === "v20") {
    throw new AppError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "Brave v20 cookies require the Brave browser context for App-Bound decryption",
    );
  }
  if (prefix !== "v10" && prefix !== "v11") {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave cookie uses an unsupported encryption format");
  }
  if (encryptedValue.byteLength < 3 + 12 + 16) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave cookie ciphertext is truncated");
  }
  try {
    const nonce = encryptedValue.subarray(3, 15);
    const body = encryptedValue.subarray(15, -16);
    const tag = encryptedValue.subarray(-16);
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to decrypt a Brave cookie", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function parseBase64(value: string, description: string): Uint8Array {
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    if (bytes.byteLength === 0) throw new Error("empty");
    return bytes;
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", `Brave ${description} is malformed`, {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

interface PowerShellResult {
  readonly stdout: string;
  readonly code: number;
}

function runPowerShell(script: string, input: string): Promise<PowerShellResult> {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const executable = process.env[POWERSHELL_ENV]?.trim() || "powershell.exe";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, code: code ?? -1 }));
    child.stdin.end(input);
  });
}

const DPAPI_SCRIPT = String.raw`
$encoded = [Console]::In.ReadToEnd().Trim()
Add-Type -AssemblyName System.Security
$encrypted = [Convert]::FromBase64String($encoded)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::WriteLine([Convert]::ToBase64String($plain))
`;

async function unprotectDpapi(value: Uint8Array): Promise<Uint8Array> {
  if (process.platform !== "win32") {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave cookie decryption requires Windows DPAPI");
  }
  let result: PowerShellResult;
  try {
    result = await runPowerShell(DPAPI_SCRIPT, Buffer.from(value).toString("base64"));
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows PowerShell is unavailable for Brave cookie decryption", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (result.code !== 0) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows DPAPI could not decrypt the Brave cookie key", {
      exitCode: result.code,
    });
  }
  return parseBase64(result.stdout.trim(), "DPAPI result");
}

function jsonString(root: unknown, path: readonly string[]): string {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave Local State is incomplete");
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "string" || current.trim() === "") throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave Local State is incomplete");
  return current;
}

async function readMasterKey(profileDir: string, unprotect: (value: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const localStatePath = join(dirname(profileDir), "Local State");
  try {
    const localState = JSON.parse(await readFile(localStatePath, "utf8")) as unknown;
    const encrypted = parseBase64(jsonString(localState, ["os_crypt", "encrypted_key"]), "encrypted key");
    if (Buffer.from(encrypted.subarray(0, 5)).toString("ascii") !== "DPAPI") {
      throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave Local State uses an unsupported key wrapper");
    }
    return unprotect(encrypted.subarray(5));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to read Brave Local State", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function rowBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave cookie ciphertext is unavailable");
}

export async function readBraveCookieHeader(
  profileDir = resolveBraveProfileDir(),
  dependencies: BraveCookieDependencies = {},
): Promise<string> {
  const unprotect = dependencies.unprotect ?? unprotectDpapi;
  const cookiesPath = join(profileDir, "Network", "Cookies");
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(cookiesPath, { readOnly: true });
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to open Brave's cookie store; close Brave and retry", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  try {
    const placeholders = COOKIE_DOMAINS.map(() => "?").join(", ");
    const rows = database.prepare(`SELECT host_key AS hostKey, name, value, encrypted_value AS encryptedValue, path FROM cookies WHERE host_key IN (${placeholders})`).all(...COOKIE_DOMAINS) as readonly Record<string, unknown>[];
    let masterKey: Uint8Array | undefined;
    const records: BraveCookieRecord[] = [];
    for (const row of rows) {
      const hostKey = typeof row.hostKey === "string" ? row.hostKey : "";
      const name = typeof row.name === "string" ? row.name : "";
      const path = typeof row.path === "string" ? row.path : "/";
      if (hostKey === "" || name === "") continue;
      const plaintext = typeof row.value === "string" ? row.value : "";
      const encryptedValue = rowBytes(row.encryptedValue);
      let value = plaintext;
      if (value === "" && encryptedValue.byteLength > 0) {
        const prefix = Buffer.from(encryptedValue.subarray(0, 3)).toString("ascii");
        if (prefix === "v20") {
          throw new AppError(
            "AUTH_CONTEXT_UNAVAILABLE",
            "Brave v20 cookies require the Brave browser context for App-Bound decryption",
          );
        }
        value = prefix === "v10" || prefix === "v11"
          ? decryptChromiumCookieValue(
              encryptedValue,
              (masterKey ??= await readMasterKey(profileDir, unprotect)),
            )
          : new TextDecoder().decode(await unprotect(encryptedValue));
      }
      records.push({ hostKey, name, value, encryptedValue, path });
    }
    const header = buildBraveCookieHeader(records);
    const names = new Set(header.split(";").map((part) => part.trim().split("=", 1)[0]));
    if (!names.has("sc-a-dbsc-session") || !names.has("__Host-sc-a-auth-session")) {
      throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave cookie store has no current Snapchat auth session");
    }
    return header;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to read Brave's cookie store", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    database.close();
  }
}

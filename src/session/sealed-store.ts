import { readFile, rm } from "node:fs/promises";
import { AppError } from "../errors.js";
import { parseJsonWithBytes, stringifyJsonWithBytes } from "./binary-json.js";
import { parseSessionExport } from "./schema.js";
import type { SessionExport } from "./types.js";
import { AtomicJsonStore } from "./state-store.js";
import { createDpapiProtector, type SessionProtector } from "./dpapi.js";

export type { SessionProtector } from "./dpapi.js";

const SEALED_KIND = "snapchat-sealed-session";
const SEALED_VERSION = 1;

export interface SealedSessionEnvelope {
  readonly kind: typeof SEALED_KIND;
  readonly version: typeof SEALED_VERSION;
  readonly ciphertext: string;
}

function parseEnvelope(value: unknown): SealedSessionEnvelope {
  if (
    value === null
    || typeof value !== "object"
    || (value as { kind?: unknown }).kind !== SEALED_KIND
    || (value as { version?: unknown }).version !== SEALED_VERSION
    || typeof (value as { ciphertext?: unknown }).ciphertext !== "string"
    || (value as { ciphertext: string }).ciphertext.trim() === ""
  ) {
    throw new AppError("INVALID_SESSION_EXPORT", "Sealed session envelope is invalid");
  }
  return value as SealedSessionEnvelope;
}

function isEnvelope(value: unknown): value is SealedSessionEnvelope {
  return value !== null
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === SEALED_KIND;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decode(value: string): Uint8Array {
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    if (bytes.byteLength === 0) throw new Error("empty");
    return bytes;
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Sealed session ciphertext is invalid");
  }
}

async function protectSession(session: SessionExport, protector: SessionProtector): Promise<SealedSessionEnvelope> {
  const plaintext = new TextEncoder().encode(stringifyJsonWithBytes(session));
  return {
    kind: SEALED_KIND,
    version: SEALED_VERSION,
    ciphertext: encode(await protector.protect(plaintext)),
  };
}

async function unprotectSession(envelope: SealedSessionEnvelope, protector: SessionProtector): Promise<SessionExport> {
  let plain: Uint8Array;
  try {
    plain = await protector.unprotect(decode(envelope.ciphertext));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to decrypt the sealed session");
  }
  try {
    return parseSessionExport(parseJsonWithBytes(new TextDecoder().decode(plain)));
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Decrypted session export is invalid");
  }
}

export class SealedSessionStore {
  private readonly envelopeStore: AtomicJsonStore<SealedSessionEnvelope>;

  constructor(
    readonly path: string,
    private readonly protector: SessionProtector = createDpapiProtector(),
  ) {
    this.envelopeStore = new AtomicJsonStore(path, parseEnvelope);
  }

  async read(): Promise<SessionExport> {
    return unprotectSession(await this.envelopeStore.read(), this.protector);
  }

  async readOrMigrateLegacy(): Promise<SessionExport> {
    let raw: unknown;
    try {
      raw = parseJsonWithBytes(await readFile(this.path, "utf8"));
    } catch {
      throw new AppError("INVALID_SESSION_EXPORT", "Unable to read session export");
    }
    if (isEnvelope(raw)) return unprotectSession(parseEnvelope(raw), this.protector);
    const legacy = parseSessionExport(raw);
    await this.write(legacy);
    // AtomicJsonStore keeps the replaced file as .previous. Do not leave the
    // imported plaintext session behind after the one-time migration.
    await rm(`${this.path}.previous`, { force: true });
    return legacy;
  }

  async write(session: SessionExport): Promise<void> {
    await this.envelopeStore.write(await protectSession(session, this.protector));
  }
}

export function isSealedSessionEnvelope(value: unknown): value is SealedSessionEnvelope {
  return isEnvelope(value);
}

import { AppError } from "../errors.js";
import { parseSessionExport } from "./schema.js";
import type {
  AssetRecord,
  IndexedDbSnapshot,
  MessagingStateExport,
  SessionExport,
} from "./types.js";
import type { BuildId } from "../builds.js";
import type { HarAuthContext } from "./har-auth.js";

export interface BrowserStateSnapshot {
  readonly pageUrl?: string;
  readonly localStorage: Readonly<Record<string, string>>;
  readonly sessionStorage: Readonly<Record<string, string>>;
  readonly indexedDb: IndexedDbSnapshot;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return objectRecord(value);
  try {
    return objectRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function extractRootWrappingKey(value: unknown): MessagingStateExport["rootWrappingKey"] | undefined {
  const envelope = parseObject(value);
  if (envelope === undefined || typeof envelope.rwk !== "string") return undefined;
  const identity = parseObject(envelope.identity);
  if (identity === undefined || typeof identity.identityKeyId !== "string") return undefined;
  return {
    data: envelope.rwk,
    identityKeyId: identity.identityKeyId,
  };
}

function findRootWrappingKey(indexedDb: IndexedDbSnapshot): MessagingStateExport["rootWrappingKey"] | undefined {
  for (const database of indexedDb.databases) {
    for (const store of database.stores) {
      for (const record of store.records) {
        if (typeof record.key !== "string" || !record.key.startsWith("uds.e2eeTempKey.")) continue;
        const rootWrappingKey = extractRootWrappingKey(record.value);
        if (rootWrappingKey !== undefined) return rootWrappingKey;
      }
    }
  }
  return undefined;
}

function findSessionStorageRootWrappingKey(
  sessionStorage: Readonly<Record<string, string>>,
): MessagingStateExport["rootWrappingKey"] | undefined {
  for (const [key, value] of Object.entries(sessionStorage)) {
    if (!key.startsWith("uds.e2eeIwekKey.")) continue;
    const envelope = parseObject(value);
    if (envelope === undefined || typeof envelope.data !== "string") continue;
    if (typeof envelope.identityKeyId !== "string") continue;
    return {
      data: envelope.data,
      identityKeyId: envelope.identityKeyId,
    };
  }
  return undefined;
}

export function createMessagingStateFromBrowserSnapshot(
  snapshot: BrowserStateSnapshot,
): MessagingStateExport {
  const rootWrappingKey =
    findRootWrappingKey(snapshot.indexedDb) ??
    findSessionStorageRootWrappingKey(snapshot.sessionStorage);
  if (rootWrappingKey === undefined) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Browser export is missing persisted messaging key state",
    );
  }
  return { rootWrappingKey, friendDevices: {} };
}

export interface CreateSessionExportInput {
  readonly buildId: BuildId;
  readonly auth: HarAuthContext;
  readonly assets: readonly AssetRecord[];
  readonly browser: BrowserStateSnapshot;
}

export function createSessionExport(input: CreateSessionExportInput): SessionExport {
  const session = {
    formatVersion: 1 as const,
    accountId: input.auth.accountId,
    buildId: input.buildId,
    exportedAt: input.auth.exportedAt,
    auth: input.auth.auth,
    assets: input.assets,
    localStorage: input.browser.localStorage,
    sessionStorage: input.browser.sessionStorage,
    messaging: createMessagingStateFromBrowserSnapshot(input.browser),
    indexedDb: input.browser.indexedDb,
  };
  return parseSessionExport(session);
}

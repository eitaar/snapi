import { AppError } from "../errors.js";
import type {
  AssetRecord,
  IndexedDbDatabaseSnapshot,
  IndexedDbIndexSnapshot,
  IndexedDbRecordSnapshot,
  IndexedDbSnapshot,
  IndexedDbStoreSnapshot,
  SessionExport,
} from "./types.js";

function invalid(path: string, reason: string): never {
  throw new AppError("INVALID_SESSION_EXPORT", "Session export validation failed", {
    path,
    reason,
  });
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "expected object");
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(path, "expected array");
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(path, "expected non-empty string");
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return invalid(path, "expected boolean");
  return value;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid(path, "expected positive safe integer");
  }
  return value as number;
}

function stringRecordAt(value: unknown, path: string): Readonly<Record<string, string>> {
  const record = objectAt(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, stringAt(entry, `${path}.${key}`)]),
  );
}

function keyPathAt(value: unknown, path: string, nullable: boolean): string | readonly string[] | null {
  if (value === null && nullable) return null;
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry, index) => stringAt(entry, `${path}[${index}]`));
  }
  return invalid(
    path,
    nullable
      ? "expected string, non-empty string array, or null"
      : "expected string or non-empty string array",
  );
}

function parseAsset(value: unknown, index: number): AssetRecord {
  const path = `assets[${index}]`;
  const asset = objectAt(value, path);
  const kind = asset.kind;
  if (kind !== "javascript" && kind !== "wasm") invalid(`${path}.kind`, "unsupported asset kind");
  const sha256 = stringAt(asset.sha256, `${path}.sha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) invalid(`${path}.sha256`, "expected SHA-256 hex");
  return {
    kind,
    filename: stringAt(asset.filename, `${path}.filename`),
    sha256,
    size: positiveIntegerAt(asset.size, `${path}.size`),
  };
}

function parseIndex(value: unknown, path: string): IndexedDbIndexSnapshot {
  const index = objectAt(value, path);
  const keyPath = keyPathAt(index.keyPath, `${path}.keyPath`, false);
  if (keyPath === null) return invalid(`${path}.keyPath`, "index keyPath cannot be null");
  return {
    name: stringAt(index.name, `${path}.name`),
    keyPath,
    unique: booleanAt(index.unique, `${path}.unique`),
    multiEntry: booleanAt(index.multiEntry, `${path}.multiEntry`),
  };
}

function parseRecord(value: unknown, path: string): IndexedDbRecordSnapshot {
  const record = objectAt(value, path);
  if (!("key" in record)) invalid(`${path}.key`, "missing key");
  if (!("value" in record)) invalid(`${path}.value`, "missing value");
  return { key: record.key, value: record.value };
}

function parseStore(value: unknown, path: string): IndexedDbStoreSnapshot {
  const store = objectAt(value, path);
  return {
    name: stringAt(store.name, `${path}.name`),
    keyPath: keyPathAt(store.keyPath, `${path}.keyPath`, true),
    autoIncrement: booleanAt(store.autoIncrement, `${path}.autoIncrement`),
    indexes: arrayAt(store.indexes, `${path}.indexes`).map((entry, index) =>
      parseIndex(entry, `${path}.indexes[${index}]`),
    ),
    records: arrayAt(store.records, `${path}.records`).map((entry, index) =>
      parseRecord(entry, `${path}.records[${index}]`),
    ),
  };
}

function parseDatabase(value: unknown, index: number): IndexedDbDatabaseSnapshot {
  const path = `indexedDb.databases[${index}]`;
  const database = objectAt(value, path);
  return {
    name: stringAt(database.name, `${path}.name`),
    version: positiveIntegerAt(database.version, `${path}.version`),
    stores: arrayAt(database.stores, `${path}.stores`).map((entry, storeIndex) =>
      parseStore(entry, `${path}.stores[${storeIndex}]`),
    ),
  };
}

function parseIndexedDb(value: unknown): IndexedDbSnapshot {
  const snapshot = objectAt(value, "indexedDb");
  return {
    databases: arrayAt(snapshot.databases, "indexedDb.databases").map(parseDatabase),
  };
}

export function parseSessionExport(value: unknown): SessionExport {
  const session = objectAt(value, "$");
  if (session.formatVersion !== 1) invalid("formatVersion", "expected version 1");
  if (session.buildId !== "8dd50222") invalid("buildId", "unsupported build");
  const exportedAt = stringAt(session.exportedAt, "exportedAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(exportedAt) ||
    Number.isNaN(Date.parse(exportedAt))
  ) {
    invalid("exportedAt", "expected an ISO-8601 UTC timestamp");
  }
  const auth = objectAt(session.auth, "auth");
  return {
    formatVersion: 1,
    accountId: stringAt(session.accountId, "accountId"),
    buildId: "8dd50222",
    exportedAt,
    auth: {
      httpToken: stringAt(auth.httpToken, "auth.httpToken"),
      gatewayToken: stringAt(auth.gatewayToken, "auth.gatewayToken"),
      cookieHeader: stringAt(auth.cookieHeader, "auth.cookieHeader"),
      requestHeaders: stringRecordAt(auth.requestHeaders, "auth.requestHeaders"),
    },
    assets: arrayAt(session.assets, "assets").map(parseAsset),
    localStorage: stringRecordAt(session.localStorage, "localStorage"),
    indexedDb: parseIndexedDb(session.indexedDb),
  };
}

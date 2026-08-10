import { indexedDB as defaultIndexedDb } from "fake-indexeddb";
import type {
  IndexedDbDatabaseSnapshot,
  IndexedDbIndexSnapshot,
  IndexedDbSnapshot,
  IndexedDbStoreSnapshot,
} from "../session/types.js";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function normalizedKeyPath(keyPath: string | readonly string[] | null): string | string[] | null {
  if (typeof keyPath === "string" || keyPath === null) return keyPath;
  return [...keyPath];
}

async function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  await requestResult(factory.deleteDatabase(name));
}

async function openFromSnapshot(
  factory: IDBFactory,
  snapshot: IndexedDbDatabaseSnapshot,
): Promise<IDBDatabase> {
  const request = factory.open(snapshot.name, snapshot.version);
  request.onupgradeneeded = () => {
    const database = request.result;
    for (const storeSnapshot of snapshot.stores) {
      const store = database.createObjectStore(storeSnapshot.name, {
        keyPath: normalizedKeyPath(storeSnapshot.keyPath),
        autoIncrement: storeSnapshot.autoIncrement,
      });
      for (const index of storeSnapshot.indexes) {
        store.createIndex(index.name, normalizedKeyPath(index.keyPath)!, {
          unique: index.unique,
          multiEntry: index.multiEntry,
        });
      }
    }
  };
  return requestResult(request);
}

async function importRecords(database: IDBDatabase, snapshot: IndexedDbDatabaseSnapshot): Promise<void> {
  if (snapshot.stores.length === 0) return;
  const transaction = database.transaction(snapshot.stores.map(({ name }) => name), "readwrite");
  for (const storeSnapshot of snapshot.stores) {
    const store = transaction.objectStore(storeSnapshot.name);
    for (const record of storeSnapshot.records) {
      if (store.keyPath === null) {
        store.put(structuredClone(record.value), structuredClone(record.key) as IDBValidKey);
      } else {
        store.put(structuredClone(record.value));
      }
    }
  }
  await transactionDone(transaction);
}

export async function importIndexedDbSnapshot(
  snapshot: IndexedDbSnapshot,
  factory: IDBFactory = defaultIndexedDb,
): Promise<void> {
  const existing = await factory.databases();
  for (const database of existing) {
    if (database.name !== undefined) await deleteDatabase(factory, database.name);
  }
  for (const databaseSnapshot of snapshot.databases) {
    const database = await openFromSnapshot(factory, databaseSnapshot);
    try {
      await importRecords(database, databaseSnapshot);
    } finally {
      database.close();
    }
  }
}

function cloneKeyPath(keyPath: string | string[] | null): string | readonly string[] | null {
  return Array.isArray(keyPath) ? [...keyPath] : keyPath;
}

async function readRecords(store: IDBObjectStore): Promise<IndexedDbStoreSnapshot["records"]> {
  return new Promise((resolve, reject) => {
    const records: { key: unknown; value: unknown }[] = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve(records);
        return;
      }
      records.push({
        key: structuredClone(cursor.primaryKey),
        value: structuredClone(cursor.value),
      });
      cursor.continue();
    };
  });
}

function readIndexes(store: IDBObjectStore): readonly IndexedDbIndexSnapshot[] {
  return [...store.indexNames].map((name) => {
    const index = store.index(name);
    return {
      name: index.name,
      keyPath: cloneKeyPath(index.keyPath)!,
      unique: index.unique,
      multiEntry: index.multiEntry,
    };
  });
}

async function exportDatabase(factory: IDBFactory, name: string): Promise<IndexedDbDatabaseSnapshot> {
  const database = await requestResult(factory.open(name));
  try {
    const storeNames = [...database.objectStoreNames];
    if (storeNames.length === 0) {
      return { name: database.name, version: database.version, stores: [] };
    }
    const transaction = database.transaction(storeNames, "readonly");
    const stores: IndexedDbStoreSnapshot[] = [];
    for (const storeName of storeNames) {
      const store = transaction.objectStore(storeName);
      stores.push({
        name: store.name,
        keyPath: cloneKeyPath(store.keyPath),
        autoIncrement: store.autoIncrement,
        indexes: readIndexes(store),
        records: await readRecords(store),
      });
    }
    await transactionDone(transaction);
    return { name: database.name, version: database.version, stores };
  } finally {
    database.close();
  }
}

export async function exportIndexedDbSnapshot(
  names: readonly string[],
  factory: IDBFactory = defaultIndexedDb,
): Promise<IndexedDbSnapshot> {
  const databases: IndexedDbDatabaseSnapshot[] = [];
  for (const name of names) databases.push(await exportDatabase(factory, name));
  return { databases };
}

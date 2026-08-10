import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { exportIndexedDbSnapshot, importIndexedDbSnapshot } from "../../src/runtime/indexeddb-snapshot.js";
import type { IndexedDbSnapshot } from "../../src/session/types.js";

const snapshot: IndexedDbSnapshot = {
  databases: [
    {
      name: "snap-db",
      version: 3,
      stores: [
        {
          name: "auto",
          keyPath: null,
          autoIncrement: true,
          indexes: [],
          records: [{ key: 1, value: { value: "generated" } }],
        },
        {
          name: "compound",
          keyPath: ["left", "right"],
          autoIncrement: false,
          indexes: [],
          records: [{ key: ["a", "b"], value: { left: "a", right: "b" } }],
        },
        {
          name: "inline",
          keyPath: "id",
          autoIncrement: false,
          indexes: [],
          records: [{ key: 7, value: { id: 7, value: "inline" } }],
        },
        {
          name: "records",
          keyPath: null,
          autoIncrement: false,
          indexes: [
            { name: "byKind", keyPath: "kind", unique: false, multiEntry: false },
          ],
          records: [
            { key: "primary", value: { kind: "alpha", payload: new Uint8Array([1, 2, 3]) } },
          ],
        },
      ],
    },
  ],
};

describe("IndexedDB snapshots", () => {
  it("round-trips stores, indexes, keys, and binary structured-clone values", async () => {
    const factory = new IDBFactory();
    await importIndexedDbSnapshot(snapshot, factory);
    await expect(exportIndexedDbSnapshot(["snap-db"], factory)).resolves.toEqual(snapshot);
  });

  it("clears existing databases before a second import", async () => {
    const factory = new IDBFactory();
    await importIndexedDbSnapshot(snapshot, factory);
    await importIndexedDbSnapshot({
      databases: [{ name: "replacement", version: 1, stores: [] }],
    }, factory);

    await expect(factory.databases()).resolves.toEqual([{ name: "replacement", version: 1 }]);
  });
});

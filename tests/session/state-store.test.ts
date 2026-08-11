import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AtomicJsonStore,
  nodeFsOps,
  type FsOps,
} from "../../src/session/state-store.js";

interface TestState {
  readonly sequence: number;
}

function parseTestState(value: unknown): TestState {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { sequence?: unknown }).sequence !== "number"
  ) {
    throw new TypeError("invalid test state");
  }
  return { sequence: (value as { sequence: number }).sequence };
}

describe("AtomicJsonStore", () => {
  it("atomically replaces state and preserves the previous valid value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-state-"));
    const statePath = join(dir, "state.json");
    const store = new AtomicJsonStore(statePath, parseTestState);

    await store.write({ sequence: 8 });
    await store.write({ sequence: 9 });

    expect(await store.read()).toEqual({ sequence: 9 });
    expect(JSON.parse(await readFile(`${statePath}.previous`, "utf8"))).toEqual({ sequence: 8 });
    await expect(readFile(`${statePath}.next`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("persists Uint8Array state as Base64 and restores the byte type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-state-bytes-"));
    const statePath = join(dir, "state.json");
    const store = new AtomicJsonStore<{ readonly payload: Uint8Array }>(statePath);

    await store.write({ payload: new Uint8Array([0, 1, 255]) });

    await expect(store.read()).resolves.toEqual({ payload: new Uint8Array([0, 1, 255]) });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      payload: { $bytes: "AAH/" },
    });
  });


  it("restores the original when the final rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-state-fail-"));
    const statePath = join(dir, "state.json");
    const initial = new AtomicJsonStore(statePath, parseTestState);
    await initial.write({ sequence: 8 });

    const failingFs: FsOps = {
      ...nodeFsOps,
      rename: async (from, to) => {
        if (from === `${statePath}.next` && to === statePath) {
          throw new Error("simulated final rename failure");
        }
        await nodeFsOps.rename(from, to);
      },
    };
    const store = new AtomicJsonStore(statePath, parseTestState, failingFs);

    await expect(store.write({ sequence: 9 })).rejects.toThrow("simulated final rename failure");
    await expect(initial.read()).resolves.toEqual({ sequence: 8 });
    await expect(readFile(`${statePath}.next`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountLock } from "../../src/session/account-lock.js";

describe("AccountLock recovery branches", () => {
  it("returns undefined when no lock exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snap-lock-empty-"));
    await expect(new AccountLock(directory).inspect("account-1")).resolves.toBeUndefined();
  });

  it("rejects each malformed lock metadata shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snap-lock-invalid-"));
    const lock = new AccountLock(directory);
    const path = join(directory, "account-1.lock");
    const invalidValues = [
      { pid: "1", accountId: "account-1", acquiredAt: "today" },
      { pid: 1, accountId: 2, acquiredAt: "today" },
      { pid: 1, accountId: "account-1", acquiredAt: 3 },
    ];

    for (const value of invalidValues) {
      await writeFile(path, JSON.stringify(value), "utf8");
      await expect(lock.inspect("account-1"))
        .rejects.toMatchObject({ code: "CRYPTO_STATE_CONFLICT" });
    }
  });

  it("makes release idempotent and tolerates an already removed lock file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snap-lock-release-"));
    const lock = new AccountLock(directory);
    const handle = await lock.acquire("account-1");
    await unlink(handle.path);
    await expect(handle.release()).resolves.toBeUndefined();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountLock } from "../../src/session/account-lock.js";

describe("AccountLock", () => {
  it("allows only one writer for an account until release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-lock-"));
    const locks = new AccountLock(join(dir, "private", "locks"));
    const first = await locks.acquire("account-1");

    try {
      await expect(locks.acquire("account-1")).rejects.toMatchObject({
        code: "CRYPTO_STATE_CONFLICT",
      });
      await expect(locks.inspect("account-1")).resolves.toMatchObject({
        pid: process.pid,
        accountId: "account-1",
      });
    } finally {
      await first.release();
    }

    const second = await locks.acquire("account-1");
    await second.release();
  });

  it("allows different account IDs to hold locks in a shared directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-lock-shared-"));
    const locks = new AccountLock(join(dir, ".locks"));
    const first = await locks.acquire("account-one");
    const second = await locks.acquire("account-two");

    await expect(locks.inspect("account-one")).resolves.toMatchObject({
      accountId: "account-one",
    });
    await expect(locks.inspect("account-two")).resolves.toMatchObject({
      accountId: "account-two",
    });

    await second.release();
    await first.release();
  });

  it("contends when two aliases resolve to the same account in a shared directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-lock-contention-"));
    const locks = new AccountLock(join(dir, ".locks"));
    const first = await locks.acquire("shared-account");

    try {
      await expect(locks.acquire("shared-account")).rejects.toMatchObject({
        code: "CRYPTO_STATE_CONFLICT",
      });
    } finally {
      await first.release();
    }
  });

  it("rejects account IDs that could escape the lock directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-lock-path-"));
    const locks = new AccountLock(join(dir, "locks"));
    await expect(locks.acquire("../other")).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});

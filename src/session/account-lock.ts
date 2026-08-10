import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "../errors.js";

export interface LockInspection {
  readonly pid: number;
  readonly accountId: string;
  readonly acquiredAt: string;
}

export interface AccountLockHandle extends AsyncDisposable {
  readonly path: string;
  release(): Promise<void>;
}

function lockFilename(accountId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
    throw new AppError("INVALID_CONFIG", "Account ID is not safe for a lock filename", {
      accountId,
    });
  }
  return `${accountId}.lock`;
}

export class AccountLock {
  constructor(private readonly lockDirectory = resolve("private", "locks")) {}

  async acquire(accountId: string): Promise<AccountLockHandle> {
    await mkdir(this.lockDirectory, { recursive: true });
    const path = join(this.lockDirectory, lockFilename(accountId));
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AppError("CRYPTO_STATE_CONFLICT", "Another process owns this account state", {
          accountId,
          path,
        });
      }
      throw new AppError("INVALID_CONFIG", "Unable to create account lock", { accountId, path });
    }

    try {
      const inspection: LockInspection = {
        pid: process.pid,
        accountId,
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(inspection)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    };
    return {
      path,
      release,
      [Symbol.asyncDispose]: release,
    };
  }

  async inspect(accountId: string): Promise<LockInspection | undefined> {
    const path = join(this.lockDirectory, lockFilename(accountId));
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value = JSON.parse(text) as Partial<LockInspection>;
    if (
      typeof value.pid !== "number" ||
      typeof value.accountId !== "string" ||
      typeof value.acquiredAt !== "string"
    ) {
      throw new AppError("CRYPTO_STATE_CONFLICT", "Account lock metadata is invalid", { path });
    }
    return {
      pid: value.pid,
      accountId: value.accountId,
      acquiredAt: value.acquiredAt,
    };
  }
}

import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface FsOps {
  readonly readText: (path: string) => Promise<string>;
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly writeSynced: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export const nodeFsOps: FsOps = {
  readText: (path) => readFile(path, "utf8"),
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeSynced: async (path, text) => {
    const handle = await open(path, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class AtomicJsonStore<T> {
  constructor(
    readonly path: string,
    private readonly parse: (value: unknown) => T = (value) => value as T,
    private readonly fs: FsOps = nodeFsOps,
  ) {}

  async read(): Promise<T> {
    return this.parse(JSON.parse(await this.fs.readText(this.path)) as unknown);
  }

  async write(value: T): Promise<void> {
    const nextPath = `${this.path}.next`;
    const previousPath = `${this.path}.previous`;
    await this.fs.ensureDirectory(dirname(this.path));
    await this.fs.writeSynced(nextPath, `${JSON.stringify(value, null, 2)}\n`);

    this.parse(JSON.parse(await this.fs.readText(nextPath)) as unknown);
    let movedCurrent = false;
    try {
      await this.fs.remove(previousPath);
      try {
        await this.fs.rename(this.path, previousPath);
        movedCurrent = true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await this.fs.rename(nextPath, this.path);
    } catch (error) {
      if (movedCurrent) {
        await this.fs.remove(this.path);
        await this.fs.rename(previousPath, this.path);
      }
      await this.fs.remove(nextPath);
      throw error;
    }
    await this.fs.remove(nextPath);
  }
}

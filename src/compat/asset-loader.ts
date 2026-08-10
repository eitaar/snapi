import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { AppError } from "../errors.js";
import type { AssetRecord } from "../session/types.js";

export interface AssetLoaderLike {
  loadVerified(record: AssetRecord): Promise<Uint8Array>;
}

function unsupported(filename: string, reason: string): AppError {
  return new AppError("UNSUPPORTED_BUILD", "Build asset verification failed", {
    filename,
    reason,
  });
}

export class AssetLoader implements AssetLoaderLike {
  constructor(private readonly assetDirectory: string) {}

  async loadVerified(record: AssetRecord): Promise<Uint8Array> {
    if (basename(record.filename) !== record.filename) {
      throw unsupported(record.filename, "asset filename must not contain a path");
    }
    if (!/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw unsupported(record.filename, "invalid expected SHA-256");
    }
    const path = resolve(this.assetDirectory, record.filename);
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of createReadStream(path)) {
        const bytes = Uint8Array.from(chunk as Buffer);
        size += bytes.length;
        if (size > record.size) throw unsupported(record.filename, "asset size mismatch");
        hash.update(bytes);
        chunks.push(bytes);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unsupported(record.filename, "asset is missing or unreadable");
    }
    if (size !== record.size) throw unsupported(record.filename, "asset size mismatch");
    const actual = hash.digest();
    const expected = Buffer.from(record.sha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw unsupported(record.filename, "asset SHA-256 mismatch");
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

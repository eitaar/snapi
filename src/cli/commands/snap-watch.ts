import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SnapMessageEvent } from "../../messaging/client.js";
import type { CliIo } from "../io.js";

export interface SnapWatchClient {
  watchSnaps(signal?: AbortSignal): AsyncIterableIterator<SnapMessageEvent>;
  close(): Promise<void>;
}

export interface ConfiguredSnapWatchClient {
  readonly client: SnapWatchClient;
  readonly output: "human" | "json";
}

function extensionFor(mimeType: string): string {
  switch (mimeType.split(";", 1)[0]!.trim().toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "video/mp4": return "mp4";
    case "audio/mp4": return "m4a";
    case "audio/mpeg": return "mp3";
    default: return "bin";
  }
}

function safePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "snap";
}

export async function runSnapWatch(
  argv: readonly string[],
  io: CliIo,
  createClient: () => Promise<ConfiguredSnapWatchClient>,
  signal?: AbortSignal,
): Promise<number> {
  let outputDir = ".snap-incoming";
  let json = false;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        "output-dir": { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    outputDir = parsed.values["output-dir"] ?? outputDir;
    json = parsed.values.json;
  } catch {
    io.stderr("Usage: snap snap watch [--output-dir DIR] [--json]");
    return 2;
  }

  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });
  const configured = await createClient();
  try {
    for await (const message of configured.client.watchSnaps(signal)) {
      const files: string[] = [];
      for (const [index, media] of (message.media ?? []).entries()) {
        const filename = `${safePart(message.timestamp)}-${safePart(message.messageId)}-${index}.${extensionFor(media.mimeType)}`;
        const path = resolve(resolvedOutputDir, filename);
        await writeFile(path, media.bytes);
        files.push(path);
      }
      if (json || configured.output === "json") {
        io.stdout(JSON.stringify({
          type: message.type,
          senderId: message.senderId,
          conversationId: message.conversationId,
          messageId: message.messageId,
          timestamp: message.timestamp,
          files,
        }));
      } else {
        io.stdout(`[${message.timestamp}] ${message.senderId}: ${files.length} Snap file(s) saved: ${files.join(", ")}`);
      }
    }
    return 0;
  } finally {
    await configured.client.close();
  }
}

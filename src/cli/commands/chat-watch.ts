import { parseArgs } from "node:util";
import type { ChatMessageEvent } from "../../messaging/client.js";
import type { CliIo } from "../io.js";

export interface ChatWatchClient {
  watchMessages(signal?: AbortSignal): AsyncIterableIterator<ChatMessageEvent>;
  close(): Promise<void>;
}

export interface ConfiguredChatWatchClient {
  readonly client: ChatWatchClient;
  readonly output: "human" | "json";
}

export type ChatWatchClientFactory = () => Promise<ConfiguredChatWatchClient>;

export async function runChatWatch(
  argv: readonly string[],
  io: CliIo,
  createClient: ChatWatchClientFactory,
  signal?: AbortSignal,
): Promise<number> {
  let json = false;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: { json: { type: "boolean", default: false } },
    });
    json = parsed.values.json;
  } catch {
    io.stderr("Usage: snap chat watch [--json]");
    return 2;
  }

  const configured = await createClient();
  try {
    for await (const message of configured.client.watchMessages(signal)) {
      if (json || configured.output === "json") {
        io.stdout(JSON.stringify(message));
      } else {
        io.stdout(`[${message.timestamp}] ${message.senderId}: ${message.text}`);
      }
    }
    return 0;
  } finally {
    await configured.client.close();
  }
}

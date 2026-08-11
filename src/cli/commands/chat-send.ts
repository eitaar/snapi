import { parseArgs } from "node:util";
import type { SendResult, SendTextInput } from "../../messaging/client.js";
import type { SendPhotoSnapInput } from "../../media/client.js";
import type { CliIo } from "../io.js";

export interface ChatSendClient {
  sendText(input: SendTextInput): Promise<SendResult>;
  sendPhotoSnap(input: SendPhotoSnapInput): Promise<SendResult>;
  close(): Promise<void>;
}

export interface ConfiguredChatSendClient {
  readonly client: ChatSendClient;
  readonly output: "human" | "json";
}

export type ChatSendClientFactory = () => Promise<ConfiguredChatSendClient>;

export async function runChatSend(
  argv: readonly string[],
  io: CliIo,
  createClient: ChatSendClientFactory,
): Promise<number> {
  let values: { readonly "conversation-id"?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { "conversation-id": { type: "string" } },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    io.stderr("Usage: snap chat send <recipient-id> <text> --conversation-id <conversation-id>");
    return 2;
  }
  const conversationId = values["conversation-id"];
  if (
    positionals.length !== 2 ||
    positionals[0]?.trim() === "" ||
    positionals[1]?.trim() === "" ||
    conversationId === undefined ||
    conversationId.trim() === ""
  ) {
    io.stderr("Usage: snap chat send <recipient-id> <text> --conversation-id <conversation-id>");
    return 2;
  }
  const recipientId = positionals[0]!;
  const text = positionals[1]!;

  const configured = await createClient();
  try {
    const result = await configured.client.sendText({
      recipientId,
      conversationId,
      text,
    });
    if (configured.output === "json") {
      io.stdout(JSON.stringify({
        type: "chat.sent",
        recipientId,
        conversationId,
        ...result,
      }));
    } else {
      io.stdout(`Chat sent (${result.clientMessageId})`);
    }
    return 0;
  } finally {
    await configured.client.close();
  }
}

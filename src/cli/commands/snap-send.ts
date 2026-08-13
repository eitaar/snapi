import { readFile as nodeReadFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AppError } from "../../errors.js";
import type { ConfiguredChatSendClient } from "./chat-send.js";
import type { CliIo } from "../io.js";

export async function runSnapSend(
  argv: readonly string[],
  io: CliIo,
  createClient: () => Promise<ConfiguredChatSendClient>,
  readFile: (path: string) => Promise<Uint8Array> = nodeReadFile,
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
    io.stderr("Usage: snap snap send <recipient-id> <image> --conversation-id <conversation-id>");
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
    io.stderr("Usage: snap snap send <recipient-id> <image> --conversation-id <conversation-id>");
    return 2;
  }
  const recipientId = positionals[0]!;
  const filename = positionals[1]!;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(await readFile(filename));
  } catch {
    throw new AppError("INVALID_IMAGE", "Unable to read the photo file");
  }
  const configured = await createClient();
  let confirmed = false;
  try {
    const result = await configured.client.sendPhotoSnap({
      recipientId,
      conversationId,
      filename,
      bytes,
    });
    confirmed = result.status === "confirmed";
    if (configured.output === "json") {
      io.stdout(JSON.stringify({
        type: "snap.sent",
        recipientId,
        conversationId,
        ...result,
      }));
    } else {
      io.stdout(`Photo Snap sent (${result.clientMessageId})`);
    }
    return 0;
  } finally {
    try {
      await configured.client.close();
    } catch {
      if (!confirmed) {
        throw new Error("Unable to clean up after an unconfirmed send");
      }
      io.stderr("CLEANUP_FORCED: Delivery was confirmed; client cleanup did not complete");
    }
  }
}

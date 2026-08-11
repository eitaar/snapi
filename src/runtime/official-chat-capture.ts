import { AppError } from "../errors.js";
import type { ChatInput, EncryptedContent } from "./content-types.js";
import {
  extractCapturedChatEnvelope,
  isCapturedCreateContentMessage,
} from "./official-captured-content.js";
import { createOfficialChatArguments } from "./official-content.js";
import {
  beginOfficialCaptureOnly,
  drainOfficialCapturedRequests,
} from "./official-host-control.js";
import {
  exposeOfficial,
  type OfficialRemote,
  type OfficialWorkerClient,
} from "./official-worker-client.js";
import type { CapturedOfficialRequest } from "./official-network.js";

export interface OfficialChatCaptureDependencies {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function captureOfficialChatEnvelope(
  runtime: OfficialWorkerClient,
  conversationManager: OfficialRemote,
  input: ChatInput,
  dependencies: OfficialChatCaptureDependencies = {},
): Promise<EncryptedContent> {
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const captured: CapturedOfficialRequest[] = [];
  const [destination, content] = createOfficialChatArguments(input);

  await beginOfficialCaptureOnly(runtime);
  await conversationManager.call<void>(["sendMessageWithContent"], [
    destination,
    content,
    exposeOfficial({
      onSuccess: () => undefined,
      onError: () => undefined,
      onQueued: () => undefined,
    }),
  ]);

  while (now() - startedAt <= timeoutMs) {
    captured.push(...await drainOfficialCapturedRequests(runtime));
    if (captured.some(isCapturedCreateContentMessage)) {
      return extractCapturedChatEnvelope(captured);
    }
    if (now() - startedAt >= timeoutMs) break;
    await sleep(10);
  }
  throw new AppError(
    "CRYPTO_RUNTIME_FAILED",
    "Official messaging runtime did not produce a captured CreateContentMessage request",
    { timeoutMs },
  );
}

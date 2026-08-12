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
  readonly prepareChat?: (input: ChatInput) => Promise<{
    readonly destination: unknown;
    readonly content: unknown;
  }>;
}

export async function captureOfficialChatEnvelope(
  runtime: OfficialWorkerClient,
  conversationManager: OfficialRemote,
  input: ChatInput,
  dependencies: OfficialChatCaptureDependencies = {},
): Promise<EncryptedContent> {
  const timeoutMs = dependencies.timeoutMs ?? 60_000;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const captured: CapturedOfficialRequest[] = [];
  let callbackStatus: unknown;
  const prepared = dependencies.prepareChat === undefined
    ? (() => {
        const [destination, content] = createOfficialChatArguments(input);
        return { destination, content };
      })()
    : await dependencies.prepareChat(input);

  await beginOfficialCaptureOnly(runtime);
  await conversationManager.call<void>(["sendMessageWithContent"], [
    prepared.destination,
    prepared.content,
    exposeOfficial({
      onSuccess: () => undefined,
      onError: (status: unknown) => { callbackStatus = status; },
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
    {
      timeoutMs,
      callbackStatus: typeof callbackStatus === "number" || typeof callbackStatus === "string"
        ? callbackStatus
        : callbackStatus === undefined ? "not-called" : typeof callbackStatus,
      capturedRequests: [...captured.reduce((summary, request) => {
        const key = `${request.method} ${new URL(request.url).pathname}`;
        summary.set(key, (summary.get(key) ?? 0) + 1);
        return summary;
      }, new Map<string, number>())].map(([path, count]) => ({ path, count })),
      capturedResponses: captured.flatMap((request) => {
        if (request.responseStatus === undefined) return [];
        return [{
          path: `${request.method} ${new URL(request.url).pathname}`,
          status: request.responseStatus,
        }];
      }),
      capturedMetrics: [...new Set(captured.flatMap((request) => {
        if (new URL(request.url).pathname !== "/graphene/web") return [];
        const text = new TextDecoder().decode(request.body);
        return [...text.matchAll(/[A-Za-z][A-Za-z0-9_.-]{4,100}/g)]
          .map(([value]) => value)
          .filter((value) => /send_message|e2ee|duplex|failure|failed|error|key_provider/i.test(value));
      }))].slice(0, 40),
    },
  );
}

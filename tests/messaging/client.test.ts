import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { MAX_CHAT_UTF8_BYTES, MessagingClient } from "../../src/messaging/client.js";
import type { ChatMessage, EncryptedContent } from "../../src/runtime/content-types.js";

function dependencies(events: string[]) {
  return {
    runtime: {
      encryptChat: vi.fn(async (): Promise<EncryptedContent> => {
        events.push("encrypt");
        return {
          bytes: new Uint8Array([7]),
          contentType: "chat" as const,
          createContentMessagePayload: new Uint8Array([1, 2, 3]),
        };
      }),
      exportState: vi.fn(async () => {
        events.push("export");
        return { localStorage: {}, sessionStorage: {}, indexedDb: { databases: [] } };
      }),
      syncMessages: vi.fn(async () => { events.push("sync"); }),
      drainChatMessages: vi.fn(async (): Promise<readonly ChatMessage[]> => []),
    },
    grpc: {
      unary: vi.fn(async () => {
        events.push("send");
        return { data: new Uint8Array(), trailers: new Map(), httpStatus: 200 };
      }),
    },
    stateStore: {
      write: vi.fn(async () => { events.push("persist"); }),
    },
    sendTyping: vi.fn(async () => { events.push("typing"); }),
    randomUuid: () => "44444444-4444-4444-8444-444444444444",
  };
}

const input = {
  recipientId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  text: "hello",
};

describe("MessagingClient", () => {
  it("sends one official payload and persists state in strict order", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const client = new MessagingClient(deps);

    await expect(client.sendText(input)).resolves.toEqual({
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      status: "confirmed",
    });

    expect(events).toEqual(["typing", "encrypt", "send", "export", "persist"]);
    expect(deps.runtime.encryptChat).toHaveBeenCalledWith({ ...input, clientMessageId: "44444444-4444-4444-8444-444444444444" });
    expect(deps.grpc.unary).toHaveBeenCalledWith(
      "messagingcoreservice.MessagingCoreService",
      "CreateContentMessage",
      new Uint8Array([1, 2, 3]),
      {
        timeoutMs: 30_000,
        retryKind: "message-with-client-id",
        replayPolicy: "ambiguous-send",
      },
    );
  });

  it("preserves a caller-provided client message ID", async () => {
    const deps = dependencies([]);
    const client = new MessagingClient(deps);
    const clientMessageId = "55555555-5555-4555-8555-555555555555";

    await client.sendText({ ...input, clientMessageId });
    expect(deps.runtime.encryptChat).toHaveBeenCalledWith({ ...input, clientMessageId });
  });

  it("rejects empty and oversized UTF-8 text before any side effect", async () => {
    const deps = dependencies([]);
    const client = new MessagingClient(deps);

    await expect(client.sendText({ ...input, text: "" })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(client.sendText({ ...input, text: "あ".repeat(Math.ceil(MAX_CHAT_UTF8_BYTES / 3) + 1) }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(deps.sendTyping).not.toHaveBeenCalled();
    expect(deps.runtime.encryptChat).not.toHaveBeenCalled();
  });

  it("fails closed if the build does not return an official request payload", async () => {
    const deps = dependencies([]);
    deps.runtime.encryptChat.mockResolvedValue({
      bytes: new Uint8Array([7]),
      contentType: "chat",
    } as EncryptedContent);
    const client = new MessagingClient(deps);

    await expect(client.sendText(input)).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    expect(deps.grpc.unary).not.toHaveBeenCalled();
  });

  it("maps an ambiguous network completion without retrying the logical send", async () => {
    const deps = dependencies([]);
    deps.grpc.unary.mockRejectedValue(new AppError("NETWORK_FAILED", "socket closed", { status: 401 }));
    const client = new MessagingClient(deps);

    await expect(client.sendText(input)).rejects.toMatchObject({
      code: "DELIVERY_UNCONFIRMED",
      details: { clientMessageId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(deps.runtime.encryptChat).toHaveBeenCalledOnce();
    expect(deps.grpc.unary).toHaveBeenCalledOnce();
    expect(deps.runtime.exportState).not.toHaveBeenCalled();
  });

  it("persists received plaintext state before ordered emission and deduplicates IDs", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const message = {
      senderId: "sender",
      conversationId: "conversation",
      messageId: "message",
      text: "received text",
      timestamp: "2026-08-11T00:00:00.000Z",
    };
    deps.runtime.drainChatMessages
      .mockResolvedValueOnce([message, message])
      .mockResolvedValueOnce([]);
    const client = new MessagingClient({ ...deps, pollDelayMs: 1 });
    const iterator = client.messages();

    await expect(iterator.next()).resolves.toEqual({
      value: { type: "chat.message", ...message },
      done: false,
    });
    expect(events).toEqual(["sync", "export", "persist"]);
    expect(deps.runtime.syncMessages).toHaveBeenCalledOnce();
    expect(deps.runtime.exportState).toHaveBeenCalledOnce();
    await iterator.return?.();
  });

  it("does not emit plaintext when persistence fails", async () => {
    const deps = dependencies([]);
    deps.runtime.drainChatMessages.mockResolvedValueOnce([{
      senderId: "sender",
      conversationId: "conversation",
      messageId: "message",
      text: "received text",
      timestamp: "now",
    }]);
    deps.stateStore.write.mockRejectedValueOnce(new Error("disk full"));
    const iterator = new MessagingClient({ ...deps, pollDelayMs: 1 }).messages();
    await expect(iterator.next()).rejects.toThrow("disk full");
  });

  it("ends message watching promptly when cancelled", async () => {
    const deps = dependencies([]);
    const controller = new AbortController();
    const iterator = new MessagingClient({ ...deps, pollDelayMs: 60_000 })
      .messages(controller.signal);
    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });
});

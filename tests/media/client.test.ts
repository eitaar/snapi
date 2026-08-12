import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { MediaClient } from "../../src/media/client.js";

function png(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0,
  ]);
}

describe("MediaClient", () => {
  it("creates a native photo payload, sends once, and persists state", async () => {
    const events: string[] = [];
    const payload = new Uint8Array([9, 8, 7]);
    const runtime = {
      createPhotoSnap: vi.fn(async () => {
        events.push("runtime");
        return { bytes: new Uint8Array([1]), contentType: "photo-snap" as const, createContentMessagePayload: payload };
      }),
      exportState: vi.fn(async () => {
        events.push("export");
        return { localStorage: {}, sessionStorage: {}, indexedDb: { databases: [] } };
      }),
    };
    const grpc = { unary: vi.fn(async () => {
      events.push("send");
      return { data: new Uint8Array(), trailers: new Map(), httpStatus: 200 };
    }) };
    const stateStore = { write: vi.fn(async () => { events.push("persist"); }) };
    const client = new MediaClient({ runtime, grpc, stateStore, randomUuid: () => "message-id" });

    await expect(client.sendPhotoSnap({
      recipientId: "recipient",
      conversationId: "conversation",
      filename: "photo.png",
      bytes: png(),
    })).resolves.toEqual({ clientMessageId: "message-id", status: "confirmed" });
    expect(events).toEqual(["runtime", "send", "export", "persist"]);
    expect(runtime.createPhotoSnap).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: "message-id", mimeType: "image/png", width: 2, height: 3,
    }));
    expect(grpc.unary).toHaveBeenCalledWith(
      "messagingcoreservice.MessagingCoreService",
      "CreateContentMessage",
      payload,
      {
        timeoutMs: 30_000,
        retryKind: "message-with-client-id",
        replayPolicy: "ambiguous-send",
      },
    );
  });

  it("does not retry an ambiguous final response", async () => {
    const grpc = { unary: vi.fn(async () => { throw new AppError("NETWORK_FAILED", "ambiguous"); }) };
    const client = new MediaClient({
      runtime: {
        createPhotoSnap: async () => ({
          bytes: new Uint8Array([1]), contentType: "photo-snap", createContentMessagePayload: new Uint8Array([2]),
        }),
        exportState: async () => ({ localStorage: {}, sessionStorage: {}, indexedDb: { databases: [] } }),
      },
      grpc,
      stateStore: { write: vi.fn() },
      randomUuid: () => "message-id",
    });
    await expect(client.sendPhotoSnap({
      recipientId: "recipient", conversationId: "conversation", filename: "photo.png", bytes: png(),
    })).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    expect(grpc.unary).toHaveBeenCalledOnce();
  });

  it("maps an ambiguous gRPC authentication failure to unconfirmed delivery", async () => {
    const grpc = { unary: vi.fn(async () => { throw new AppError("GRPC_FAILED", "auth failed", { grpcStatus: 16 }); }) };
    const client = new MediaClient({
      runtime: {
        createPhotoSnap: async () => ({
          bytes: new Uint8Array([1]), contentType: "photo-snap", createContentMessagePayload: new Uint8Array([2]),
        }),
        exportState: async () => ({ localStorage: {}, sessionStorage: {}, indexedDb: { databases: [] } }),
      },
      grpc,
      stateStore: { write: vi.fn() },
      randomUuid: () => "message-id",
    });

    await expect(client.sendPhotoSnap({
      recipientId: "recipient", conversationId: "conversation", filename: "photo.png", bytes: png(),
    })).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    expect(grpc.unary).toHaveBeenCalledOnce();
  });
});

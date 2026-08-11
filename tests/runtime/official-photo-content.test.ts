import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OfficialPhotoContentBuilder } from "../../src/runtime/official-photo-content.js";
import { captureWebpackModules } from "../../src/compat/module-scanner.js";
import { createWebpackRuntime, rebindWebpackFactories } from "../../src/runtime/webpack-runtime.js";

describe("official native photo content", () => {
  it("builds Snap content and retains its local media reference", async () => {
    const source = await readFile("private/assets/41f8a232e0dafca526c7.js", "utf8");
    const builder = new OfficialPhotoContentBuilder(source);
    const prepared = await builder.prepare({
      recipientId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      mimeType: "image/png",
      width: 2,
      height: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(prepared.destination.conversations[0]?.str).toBe("33333333-3333-4333-8333-333333333333");
    expect(prepared.content).toMatchObject({ contentType: 1, localMediaReferences: [expect.any(Object)] });
    expect((prepared.content.content as Uint8Array).length).toBeGreaterThan(0);
    const media = builder.resolveMedia(prepared.content.localMediaReferences[0]);
    expect(media).toMatchObject({ type: "Image", hasAudio: false });
    expect(media?.data).toBeInstanceOf(Blob);
    expect(media?.data.size).toBe(3);

    const encrypted = await builder.encryptMedia(prepared.content.localMediaReferences[0]);
    expect(encrypted.encryptedData).not.toEqual(new Uint8Array([1, 2, 3]));
    expect(encrypted.encryptedData.length % 16).toBe(0);

    const contentObject = new Uint8Array([9, 8, 7]);
    const finalized = await builder.finalizeUpload(
      prepared.content,
      0,
      prepared.content.localMediaReferences[0],
      contentObject,
      encrypted.cryptoKeyIvPair,
    );
    expect(finalized.content.content.length).toBeGreaterThan(prepared.content.content.length);
    expect(finalized.remoteMediaReferences).toEqual({
      mediaReferences: [{
        contentObject,
        mediaListId: 0n,
        mediaType: 2,
        mediaReferenceKey: "",
      }],
    });
    expect(builder.uploadResult(finalized.remoteMediaReferences, true)).toMatchObject({
      status: 0,
      remoteMediaReferences: finalized.remoteMediaReferences,
    });
    expect(builder.uploadResult(undefined, false)).toMatchObject({
      failedStep: 0,
    });
  });

  it("rejects invalid destinations and missing local references", async () => {
    const source = await readFile("private/assets/41f8a232e0dafca526c7.js", "utf8");
    const builder = new OfficialPhotoContentBuilder(source);
    await expect(builder.prepare({
      recipientId: "recipient",
      conversationId: "not-a-uuid",
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      mimeType: "image/png",
      width: 1,
      height: 1,
      bytes: new Uint8Array([1]),
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(builder.encryptMedia({ id: new Uint8Array([99]) }))
      .rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("decodes official text MessageContent from conversation callbacks", async () => {
    const source = await readFile("private/assets/41f8a232e0dafca526c7.js", "utf8");
    const builder = new OfficialPhotoContentBuilder(source);
    const runtime = createWebpackRuntime(rebindWebpackFactories(captureWebpackModules(source)));
    const codec = runtime.require("79752") as {
      readonly v: { readonly encode: (value: unknown) => { readonly finish: () => Uint8Array } };
    };
    const enums = runtime.require("20606") as { readonly cM: { readonly CHAT: number } };
    const content = codec.v.encode({
      content: { $case: "text", text: { attributes: [], text: "official text" } },
    }).finish();

    expect(builder.decodeChatMessages([{
      descriptor: { messageId: "message", conversationId: "conversation" },
      senderId: "sender",
      messageContent: { content, contentType: enums.cM.CHAT },
    }], "2026-08-11T00:00:00.000Z")).toEqual([{
      senderId: "sender",
      conversationId: "conversation",
      messageId: "message",
      text: "official text",
      timestamp: "2026-08-11T00:00:00.000Z",
    }]);
  });

  it("builds Chat MessageContent through the pinned official helper", async () => {
    const source = await readFile("private/assets/41f8a232e0dafca526c7.js", "utf8");
    const builder = new OfficialPhotoContentBuilder(source);
    const prepared = await builder.prepareChat({
      recipientId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      text: "official chat text",
    });

    expect(prepared.destination.conversations[0]?.str)
      .toBe("33333333-3333-4333-8333-333333333333");
    expect(prepared.content).toMatchObject({ contentType: 2, savePolicy: 1 });
    expect(builder.decodeChatMessages([{
      descriptor: { messageId: "message", conversationId: "conversation" },
      senderId: "sender",
      messageContent: prepared.content,
    }])[0]?.text).toBe("official chat text");
  });
});

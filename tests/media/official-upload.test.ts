import { describe, expect, it, vi } from "vitest";
import { uploadOfficialPhotoContent } from "../../src/media/official-upload.js";
import { concatBytes, writeBytesField, writeStringField, writeVarintField } from "../../src/wire/protobuf.js";

function response(contentObject: Uint8Array): Uint8Array {
  return writeBytesField(1, concatBytes(
    writeStringField(1, "https://cf-st.sc-cdn.net/r/signed-secret"),
    writeBytesField(2, writeVarintField(1, 1_800_000_000)),
    writeBytesField(3, writeVarintField(1, 86_400)),
    writeBytesField(4, writeBytesField(3, contentObject)),
  ));
}

describe("official photo upload", () => {
  it("encrypts, obtains a location, uploads once, and finalizes content in order", async () => {
    const events: string[] = [];
    const reference = { id: new Uint8Array([1]) };
    const original = { content: new Uint8Array([2]), contentType: 1, localMediaReferences: [reference] };
    const finalized = { ...original, content: new Uint8Array([3]) };
    const key = await crypto.subtle.generateKey({ name: "AES-CBC", length: 256 }, true, ["encrypt"]);
    const builder = {
      encryptMedia: vi.fn(async () => {
        events.push("encrypt");
        return { encryptedData: new Uint8Array([7, 8]), cryptoKeyIvPair: { key, iv: new Uint8Array(16) } };
      }),
      finalizeUpload: vi.fn(async () => {
        events.push("finalize");
        return { content: finalized, remoteMediaReferences: { mediaReferences: [] } };
      }),
    };
    const grpc = {
      unary: vi.fn(async () => {
        events.push("location");
        return { data: response(new Uint8Array([9])), trailers: new Map(), httpStatus: 200 };
      }),
    };
    const fetch = vi.fn(async () => {
      events.push("put");
      return new Response(null, { status: 200 });
    });

    await expect(uploadOfficialPhotoContent(original, { builder, grpc, fetch }))
      .resolves.toEqual({ content: finalized, remoteMediaReferences: { mediaReferences: [] } });
    expect(events).toEqual(["encrypt", "location", "put", "finalize"]);
    expect(grpc.unary).toHaveBeenCalledWith(
      "snapchat.content.v2.MediaDeliveryService",
      "GetUploadLocations",
      expect.any(Uint8Array),
      { timeoutMs: 30_000, retryKind: "idempotent" },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(builder.finalizeUpload).toHaveBeenCalledWith(
      original, 0, reference, new Uint8Array([9]), expect.any(Object),
    );
  });

  it("does not finalize and does not expose a signed URL when PUT fails", async () => {
    const signedUrl = "https://cf-st.sc-cdn.net/r/signed-secret-sentinel";
    const payload = writeBytesField(1, concatBytes(
      writeStringField(1, signedUrl),
      writeBytesField(2, writeVarintField(1, 1)),
      writeBytesField(3, writeVarintField(1, 1)),
      writeBytesField(4, writeBytesField(3, new Uint8Array([1]))),
    ));
    const key = await crypto.subtle.generateKey({ name: "AES-CBC", length: 256 }, true, ["encrypt"]);
    const finalizeUpload = vi.fn();
    const promise = uploadOfficialPhotoContent(
      { content: new Uint8Array([1]), contentType: 1, localMediaReferences: [{}] },
      {
        builder: {
          encryptMedia: async () => ({ encryptedData: new Uint8Array([2]), cryptoKeyIvPair: { key, iv: new Uint8Array(16) } }),
          finalizeUpload,
        },
        grpc: { unary: async () => ({ data: payload, trailers: new Map(), httpStatus: 200 }) },
        fetch: async () => new Response(null, { status: 500 }),
      },
    );
    await expect(promise).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    await expect(promise).rejects.not.toThrow(signedUrl);
    expect(finalizeUpload).not.toHaveBeenCalled();
  });
});

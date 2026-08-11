import { describe, expect, it } from "vitest";
import { classifyGatewayEnvelope } from "../../src/gateway/classifier.js";
import { concatBytes, writeBytesField, writeVarintField } from "../../src/wire/protobuf.js";

const messageId = Uint8Array.from([
  0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x43, 0x33,
  0x84, 0x44, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
]);

function stateBranch(branch: 11 | 13): Uint8Array {
  return writeBytesField(6, concatBytes(
    writeBytesField(1, messageId),
    writeVarintField(2, 987_654),
    writeBytesField(branch, new Uint8Array()),
  ));
}

describe("Gateway event classifier", () => {
  it("classifies the observed MessageCreate branch as encrypted chat", () => {
    const protectedEnvelope = new Uint8Array([7, 8, 9]);
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: writeBytesField(1, protectedEnvelope) }, "2026-08-11T00:00:00.000Z"))
      .toEqual({ type: "chat.encrypted", envelope: protectedEnvelope, receivedAt: "2026-08-11T00:00:00.000Z" });
  });

  it("classifies observed open, replay, and screenshot branches", () => {
    const open = writeBytesField(12, concatBytes(
      writeBytesField(1, messageId),
      writeVarintField(2, 123_456),
      writeBytesField(9, new Uint8Array()),
    ));
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: open }, "now"))
      .toMatchObject({ type: "snap.opened", sequence: 123_456n });
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: stateBranch(13) }, "now"))
      .toMatchObject({ type: "snap.replayed", sequence: 987_654n });
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: stateBranch(11) }, "now"))
      .toMatchObject({ type: "snap.screenshot", sequence: 987_654n });
  });

  it("ignores pcs and reports only safe metadata for unknown mcs branches", () => {
    expect(classifyGatewayEnvelope({ path: "pcs", messageContents: new Uint8Array([8, 1]) }, "now"))
      .toBeUndefined();
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: writeVarintField(7, 42) }, "now"))
      .toEqual({ type: "gateway.unknown", path: "mcs", fieldNumbers: [7], receivedAt: "now" });
  });

  it("fails closed on malformed and incomplete observed branches", () => {
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: new Uint8Array([0xff]) }, "now"))
      .toEqual({ type: "gateway.unknown", path: "mcs", fieldNumbers: [], receivedAt: "now" });
    expect(classifyGatewayEnvelope({ path: "other", messageContents: writeVarintField(3, 1) }, "now"))
      .toEqual({ type: "gateway.unknown", path: "other", fieldNumbers: [3], receivedAt: "now" });
    const incompleteOpen = writeBytesField(12, concatBytes(
      writeVarintField(2, 5),
      writeBytesField(9, new Uint8Array()),
    ));
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: incompleteOpen }, "now"))
      .toMatchObject({ type: "gateway.unknown" });
  });

  it("keeps messageId optional for replay events", () => {
    const replay = writeBytesField(6, concatBytes(
      writeVarintField(2, 321),
      writeBytesField(13, new Uint8Array()),
    ));
    expect(classifyGatewayEnvelope({ path: "mcs", messageContents: replay }, "now"))
      .toEqual({ type: "snap.replayed", sequence: 321n, receivedAt: "now" });
  });
});

import type { GatewayEnvelope } from "../wire/gateway-envelope.js";
import { readFields, type ProtobufField } from "../wire/protobuf.js";
import type { GatewayEvent } from "./events.js";

function uuid(bytes: Uint8Array): string | undefined {
  if (bytes.length !== 16) return undefined;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nestedBranch(
  field: ProtobufField,
  marker: 9 | 11 | 13,
): { readonly messageId?: string; readonly sequence: bigint } | undefined {
  if (field.wireType !== 2) return undefined;
  const nested = readFields(field.value);
  const hasMarker = nested.some((candidate) =>
    candidate.fieldNumber === marker && candidate.wireType === 2 && candidate.value.length === 0);
  if (!hasMarker) return undefined;
  const sequence = nested.find((candidate) => candidate.wireType === 0)?.value;
  if (sequence === undefined) return undefined;
  const messageId = nested.flatMap((candidate) =>
    candidate.wireType === 2 ? [uuid(candidate.value)] : [])
    .find((candidate): candidate is string => candidate !== undefined);
  return { ...(messageId === undefined ? {} : { messageId }), sequence };
}

function unknown(
  path: string,
  fields: readonly ProtobufField[],
  receivedAt: string,
): GatewayEvent {
  return {
    type: "gateway.unknown",
    path,
    fieldNumbers: [...new Set(fields.map(({ fieldNumber }) => fieldNumber))].sort((a, b) => a - b),
    receivedAt,
  };
}

export function classifyGatewayEnvelope(
  envelope: GatewayEnvelope,
  receivedAt = new Date().toISOString(),
): GatewayEvent | undefined {
  if (envelope.path === "pcs") return undefined;
  let fields: readonly ProtobufField[];
  try {
    fields = readFields(envelope.messageContents);
  } catch {
    return { type: "gateway.unknown", path: envelope.path, fieldNumbers: [], receivedAt };
  }
  if (envelope.path !== "mcs") return unknown(envelope.path, fields, receivedAt);

  const messageCreate = fields.filter(({ fieldNumber, wireType }) => fieldNumber === 1 && wireType === 2);
  if (fields.length === 1 && messageCreate.length === 1) {
    return {
      type: "chat.encrypted",
      envelope: (messageCreate[0] as Extract<ProtobufField, { wireType: 2 }>).value,
      receivedAt,
    };
  }

  try {
    const openField = fields.find(({ fieldNumber }) => fieldNumber === 12);
    if (openField !== undefined) {
      const state = nestedBranch(openField, 9);
      if (state?.messageId !== undefined) {
        return { type: "snap.opened", messageId: state.messageId, sequence: state.sequence, receivedAt };
      }
    }
    const updateField = fields.find(({ fieldNumber }) => fieldNumber === 6);
    if (updateField !== undefined) {
      const screenshot = nestedBranch(updateField, 11);
      if (screenshot !== undefined) {
        return { type: "snap.screenshot", ...screenshot, receivedAt };
      }
      const replay = nestedBranch(updateField, 13);
      if (replay !== undefined) {
        return { type: "snap.replayed", ...replay, receivedAt };
      }
    }
  } catch {
    return unknown(envelope.path, fields, receivedAt);
  }
  return unknown(envelope.path, fields, receivedAt);
}

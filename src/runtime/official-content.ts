import { AppError } from "../errors.js";
import { writeBytesField, writeStringField } from "../wire/protobuf.js";
import type { ChatInput } from "./content-types.js";

export interface OfficialUuidValue {
  readonly id: Uint8Array;
  readonly str: string;
}

export interface OfficialDeliveryDestination {
  readonly phoneNumbers: readonly unknown[];
  readonly conversations: readonly OfficialUuidValue[];
  readonly stories: readonly unknown[];
  readonly massSnaps: readonly unknown[];
}

export interface OfficialChatContent {
  readonly content: Uint8Array;
  readonly quotedMessageId: undefined;
  readonly contentType: 2;
  readonly platformAnalytics: {
    readonly content: undefined;
    readonly metricsMessageType: 0;
    readonly metricsMessageMediaType: 0;
    readonly reactionSource: 0;
    readonly attemptId: OfficialUuidValue;
  };
  readonly localMediaReferences: readonly unknown[];
  readonly incidentalAttachments: readonly unknown[];
  readonly savePolicy: 1;
  readonly allowsTranscription: false;
  readonly botMention: false;
}

function uuidValue(value: string, field: string): OfficialUuidValue {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new AppError("INVALID_CONFIG", `${field} must be a UUID`, { field });
  }
  return {
    id: Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))),
    str: value.toLowerCase(),
  };
}

export function encodeOfficialChatContents(text: string): Uint8Array {
  const encodedText = text === "" ? new Uint8Array() : writeStringField(1, text);
  return writeBytesField(2, encodedText);
}

export function createOfficialChatArguments(
  input: ChatInput,
): readonly [OfficialDeliveryDestination, OfficialChatContent] {
  const conversationId = uuidValue(input.conversationId, "conversationId");
  const attemptId = uuidValue(input.clientMessageId, "clientMessageId");
  return [
    {
      phoneNumbers: [],
      conversations: [conversationId],
      stories: [],
      massSnaps: [],
    },
    {
      content: encodeOfficialChatContents(input.text),
      quotedMessageId: undefined,
      contentType: 2,
      platformAnalytics: {
        content: undefined,
        metricsMessageType: 0,
        metricsMessageMediaType: 0,
        reactionSource: 0,
        attemptId,
      },
      localMediaReferences: [],
      incidentalAttachments: [],
      savePolicy: 1,
      allowsTranscription: false,
      botMention: false,
    },
  ];
}

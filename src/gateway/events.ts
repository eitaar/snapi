export type GatewayEvent =
  | {
      readonly type: "chat.encrypted";
      readonly envelope: Uint8Array;
      readonly receivedAt: string;
    }
  | {
      readonly type: "snap.opened";
      readonly messageId: string;
      readonly sequence: bigint;
      readonly receivedAt: string;
    }
  | {
      readonly type: "snap.replayed";
      readonly messageId?: string;
      readonly sequence: bigint;
      readonly receivedAt: string;
    }
  | {
      readonly type: "snap.screenshot";
      readonly messageId?: string;
      readonly sequence: bigint;
      readonly receivedAt: string;
    }
  | {
      readonly type: "gateway.unknown";
      readonly path: string;
      readonly fieldNumbers: readonly number[];
      readonly receivedAt: string;
    };

export type GatewayStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

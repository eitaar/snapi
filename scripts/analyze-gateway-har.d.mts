export interface GatewayFrameDescriptor {
  readonly direction: "send" | "receive";
  readonly opcode?: number;
  readonly encodedLength: number;
  readonly decodedLength?: number;
  readonly grpcKinds: readonly string[];
  readonly gatewayPaths: readonly string[];
}

export interface GatewayHarAnalysis {
  readonly gatewayHandshakes: readonly Readonly<Record<string, unknown>>[];
  readonly pathSequence: readonly string[];
}

export function analyzeGatewayHar(har: unknown): GatewayHarAnalysis;

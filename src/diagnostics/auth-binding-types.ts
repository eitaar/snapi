export type AuthBindingContext =
  | "brave-natural"
  | "brave-reload"
  | "brave-restart"
  | "brave-h2-natural"
  | "brave-page-replay"
  | "brave-worker-replay"
  | "node-http1"
  | "node-http2"
  | "dotnet-http3"
  | "node-gateway"
  | "dotnet-gateway";

export type AuthBindingOperation = "messaging-read" | "gateway-handshake";

export type AuthBindingProtocol = "http/1.1" | "h2" | "h3" | "websocket";

export interface SafeAuthBindingObservation {
  readonly authEpoch: string;
  readonly context: AuthBindingContext;
  readonly operation: AuthBindingOperation;
  readonly endpointPath: string;
  readonly startedAt: string;
  readonly status?: number;
  readonly protocol?: AuthBindingProtocol;
  readonly requestBodyBytes?: number;
  readonly requestBodySha256?: string;
  readonly safeHeaderNames: readonly string[];
  readonly tokenEqualsEpochBaseline: boolean;
  readonly connectionEqualsPrevious?: boolean;
  readonly browserProcessEqualsPrevious?: boolean;
  readonly networkRouteEqualsBaseline?: boolean;
  readonly bootstrapStage?: string;
  readonly transportError?: "timeout" | "connection" | "tls" | "other";
}

export type AuthBindingKind =
  | "token-freshness-bound"
  | "connection-instance-bound"
  | "browser-process-or-profile-bound"
  | "http3-quic-bound"
  | "tls-client-bound"
  | "browser-principal-bound"
  | "bootstrap-sequence-bound"
  | "server-side-browser-binding"
  | "insufficient-evidence";

export interface AuthBindingConclusion {
  readonly kind: AuthBindingKind;
  readonly operation: AuthBindingOperation | "mixed";
  readonly evidenceContexts: readonly AuthBindingContext[];
  readonly reason: string;
}

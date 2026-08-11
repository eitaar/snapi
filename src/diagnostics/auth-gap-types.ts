export type ProbeContext =
  | "edge-original"
  | "edge-page-replay"
  | "edge-extension"
  | "node-bearer"
  | "node-web-cookie"
  | "node-http2";

export interface SafeAuthGapObservation {
  readonly authEpoch: string;
  readonly context: ProbeContext;
  readonly endpointPath: string;
  readonly method: "POST";
  readonly startedAt: string;
  readonly status?: number;
  readonly nextHopProtocol?: string;
  readonly requestBodyBytes: number;
  readonly requestBodySha256: string;
  readonly safeHeaderNames: readonly string[];
  readonly transportError?: "timeout" | "connection" | "tls" | "other";
}

export type AuthGapConclusion =
  | { readonly kind: "web-cookie-required"; readonly directNodeStillViable: true }
  | { readonly kind: "request-freshness-or-single-use"; readonly directNodeStillViable: undefined }
  | { readonly kind: "browser-context-required"; readonly directNodeStillViable: false }
  | { readonly kind: "http2-or-tls-difference"; readonly directNodeStillViable: undefined }
  | { readonly kind: "insufficient-evidence"; readonly directNodeStillViable: undefined };

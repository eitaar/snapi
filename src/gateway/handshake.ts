import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { AppError } from "../errors.js";

export const DEFAULT_GATEWAY_URL =
  "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect";
const GATEWAY_ORIGIN = "https://www.snapchat.com";

export type GatewayHandshakeClassification =
  | "open"
  | "authorization-rejected"
  | "rate-limited"
  | "unexpected-status";

export interface GatewayHandshakeObservation {
  readonly status: number;
  readonly classification: GatewayHandshakeClassification;
  readonly protocol: "snap-ws-auth" | "other" | "none";
  readonly headerNames: readonly string[];
  readonly durationMs: number;
}

function protocol(value: string | readonly string[] | undefined): GatewayHandshakeObservation["protocol"] {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === "snap-ws-auth") return "snap-ws-auth";
  return first === undefined ? "none" : "other";
}

function classification(status: number): GatewayHandshakeClassification {
  if (status === 101) return "open";
  if (status === 401 || status === 403) return "authorization-rejected";
  if (status === 429) return "rate-limited";
  return "unexpected-status";
}

export function summarizeGatewayHandshake(
  status: number,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  durationMs: number,
): GatewayHandshakeObservation {
  const protocolHeader = Object.entries(headers).find(([name]) =>
    name.toLowerCase() === "sec-websocket-protocol",
  )?.[1];
  return {
    status,
    classification: classification(status),
    protocol: protocol(protocolHeader),
    headerNames: Object.keys(headers).map((name) => name.toLowerCase()).sort(),
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

function urlForHttps(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:") {
    throw new AppError("INVALID_CONFIG", "Gateway handshake URL must use wss");
  }
  parsed.protocol = "https:";
  return parsed;
}

export async function probeGatewayHandshake(
  gatewayToken: string,
  options: {
    readonly url?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<GatewayHandshakeObservation> {
  if (gatewayToken.trim() === "") {
    throw new AppError("INVALID_SESSION_EXPORT", "Gateway token is missing");
  }
  const url = urlForHttps(options.url ?? DEFAULT_GATEWAY_URL);
  const startedAt = Date.now();
  const key = randomBytes(16).toString("base64");
  return new Promise<GatewayHandshakeObservation>((resolve, reject) => {
    let settled = false;
    const finish = (observation: GatewayHandshakeObservation): void => {
      if (settled) return;
      settled = true;
      resolve(observation);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(new AppError("GATEWAY_DISCONNECTED", "Gateway handshake probe failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
    };
    const request = httpsRequest(url, {
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
        "sec-websocket-protocol": `snap-ws-auth, ${gatewayToken}`,
        "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
        origin: GATEWAY_ORIGIN,
      },
      timeout: options.timeoutMs ?? 10_000,
    }, (response) => {
      response.resume();
      finish(summarizeGatewayHandshake(response.statusCode ?? 0, response.headers, Date.now() - startedAt));
      request.destroy();
    });
    request.once("upgrade", (response, socket) => {
      finish(summarizeGatewayHandshake(101, response.headers, Date.now() - startedAt));
      socket.destroy();
      request.destroy();
    });
    request.once("timeout", () => request.destroy(new Error("Gateway handshake timed out")));
    request.once("error", fail);
    request.end();
  });
}

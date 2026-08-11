import type { GatewayStatus } from "../../gateway/events.js";
import type { CliIo } from "../io.js";

export interface GatewayStatusClient {
  watchEvents(): Promise<AsyncIterableIterator<unknown>>;
  status(): GatewayStatus;
  close(): Promise<void>;
}

export interface ConfiguredGatewayStatusClient {
  readonly client: GatewayStatusClient;
  readonly output: "human" | "json";
}

export type GatewayStatusClientFactory = () => Promise<ConfiguredGatewayStatusClient>;

export async function runGatewayStatus(
  io: CliIo,
  createClient: GatewayStatusClientFactory,
): Promise<number> {
  const configured = await createClient();
  try {
    await configured.client.watchEvents();
    const status = configured.client.status();
    if (configured.output === "json") {
      io.stdout(JSON.stringify({ type: "gateway.status", status }));
    } else {
      io.stdout(`Gateway status: ${status}`);
    }
    return 0;
  } finally {
    await configured.client.close();
  }
}

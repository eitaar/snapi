import type { CapturedOfficialRequest } from "./official-network.js";
import type { OfficialWorkerClient } from "./official-worker-client.js";

interface OfficialHostCallable {
  apply<T>(path: readonly string[], args?: readonly unknown[]): Promise<T>;
}

function hostCallable(client: OfficialWorkerClient): OfficialHostCallable {
  return client as unknown as OfficialHostCallable;
}

export async function beginOfficialCaptureOnly(client: OfficialWorkerClient): Promise<void> {
  await hostCallable(client).apply(["__host", "beginCaptureOnly"]);
}

export function drainOfficialCapturedRequests(
  client: OfficialWorkerClient,
): Promise<readonly CapturedOfficialRequest[]> {
  return hostCallable(client).apply(["__host", "drainCapturedRequests"]);
}

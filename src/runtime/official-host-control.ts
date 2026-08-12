import type {
  CapturedOfficialRequest,
  ObservedOfficialRequest,
} from "./official-network.js";
import type { OfficialWorkerClient } from "./official-worker-client.js";
import { sanitizeFriendSnapshot } from "../friends/snapshot.js";
import type { FriendSnapshot } from "../friends/types.js";

interface OfficialHostCallable {
  apply<T>(path: readonly string[], args?: readonly unknown[]): Promise<T>;
}

function hostCallable(client: OfficialWorkerClient): OfficialHostCallable {
  return client as unknown as OfficialHostCallable;
}

export async function setOfficialWebCookie(
  client: OfficialWorkerClient,
  cookieHeader: string,
): Promise<void> {
  await hostCallable(client).apply(["__host", "setWebCookieHeader"], [cookieHeader]);
}

export async function beginOfficialCaptureOnly(client: OfficialWorkerClient): Promise<void> {
  await hostCallable(client).apply(["__host", "beginCaptureOnly"]);
}

export function drainOfficialCapturedRequests(
  client: OfficialWorkerClient,
): Promise<readonly CapturedOfficialRequest[]> {
  return hostCallable(client).apply(["__host", "drainCapturedRequests"]);
}

export function drainOfficialObservedRequests(
  client: OfficialWorkerClient,
): Promise<readonly ObservedOfficialRequest[]> {
  return hostCallable(client).apply(["__host", "drainObservedRequests"]);
}

export async function syncOfficialFriends(
  client: OfficialWorkerClient,
  accountId?: string,
): Promise<FriendSnapshot> {
  const value = accountId === undefined
    ? await hostCallable(client).apply<unknown>(["__host", "syncFriends"])
    : await hostCallable(client).apply<unknown>(["__host", "syncFriends"], [accountId]);
  return sanitizeFriendSnapshot(value);
}

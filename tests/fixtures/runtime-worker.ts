import { parentPort as nullableParentPort, workerData } from "node:worker_threads";

const parentPort = nullableParentPort;
if (parentPort === null) throw new Error("runtime fixture requires a parent port");

parentPort.on("message", (request: Record<string, unknown>) => {
  const id = request.id as number;
  if (request.method === "initialize") {
    const session = request.session as { accountId: string };
    if (session.accountId === "protocol-violation") {
      parentPort.postMessage({ unexpected: true });
      return;
    }
    const initializedAt = session.accountId === "network-option"
      ? String((workerData as { allowNetwork?: boolean }).allowNetwork === true)
      : "2026-08-10T00:00:00.000Z";
    parentPort.postMessage({ id, ok: true, value: { buildId: "8dd50222", initializedAt } });
    return;
  }
  if (request.method === "encryptChat") {
    const input = request.input as { text: string };
    if (input.text === "timeout") return;
    const delay = input.text === "slow" ? 30 : 0;
    setTimeout(() => {
      parentPort.postMessage({
        id,
        ok: true,
        value: { bytes: new TextEncoder().encode(input.text), contentType: "chat" },
      });
    }, delay);
    return;
  }
  if (request.method === "decryptChat") {
    parentPort.postMessage({
      id,
      ok: true,
      value: {
        senderId: "sender",
        conversationId: "conversation",
        messageId: "message",
        text: "decrypted",
        timestamp: "2026-08-10T00:00:00.000Z",
      },
    });
    return;
  }
  if (request.method === "createPhotoSnap") {
    parentPort.postMessage({ id, ok: true, value: { bytes: new Uint8Array([9]), contentType: "photo-snap" } });
    return;
  }
  if (request.method === "refreshAuth") {
    parentPort.postMessage({
      id,
      ok: false,
      error: { code: "SESSION_REEXPORT_REQUIRED", message: "refresh unavailable", details: { safe: true } },
    });
    return;
  }
  if (request.method === "exportState") {
    parentPort.postMessage({ id, ok: true, value: { localStorage: {}, indexedDb: { databases: [] } } });
    return;
  }
  if (request.method === "shutdown") {
    parentPort.postMessage({ id, ok: true, value: undefined });
    parentPort.close();
  }
});

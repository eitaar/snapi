import { MessageChannel, parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("fixture requires parentPort");
let nextId = 1;
let captureOnly = false;
let captured = [];

function callRemote(endpoint, path, args = []) {
  const id = `chat-${nextId++}`;
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      endpoint.off("message", onMessage);
      if (message.type === "RAW") resolve(message.value);
      else reject(new Error(message.value?.value?.message ?? "callback failed"));
    };
    endpoint.on("message", onMessage);
    endpoint.start?.();
    endpoint.postMessage({
      id,
      type: "APPLY",
      path,
      argumentList: args.map((value) => ({ type: "RAW", value })),
    });
  });
}

function expose(endpoint, handlers) {
  endpoint.on("message", async (message) => {
    const path = Array.isArray(message.path) ? message.path.join(".") : "";
    try {
      const args = (message.argumentList ?? []).map((entry) => entry.value);
      const value = await handlers[path](...args);
      if (value?.fixtureProxy === true) {
        const { port1, port2 } = new MessageChannel();
        expose(port1, value.handlers);
        endpoint.postMessage({ id: message.id, type: "HANDLER", name: "proxy", value: port2 }, [port2]);
      } else {
        endpoint.postMessage({ id: message.id, type: "RAW", value });
      }
    } catch (error) {
      endpoint.postMessage({
        id: message.id,
        type: "HANDLER",
        name: "throw",
        value: { isError: true, value: { name: error.name, message: error.message } },
      });
    }
  });
  endpoint.start?.();
}

function grpcDataFrame(payload) {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

expose(parentPort, {
  "__host.beginCaptureOnly": () => {
    captureOnly = true;
    return true;
  },
  "__host.drainCapturedRequests": () => {
    const value = captured;
    captured = [];
    return value;
  },
  createMessagingSession: async () => ({
    fixtureProxy: true,
    handlers: {
      getConversationManager: () => ({
        fixtureProxy: true,
        handlers: {
          sendMessageWithContent: async (destination, content, callback) => {
            if (!captureOnly) throw new Error("capture-only was not enabled first");
            if (destination?.conversations?.[0]?.str !== "33333333-3333-4333-8333-333333333333") {
              throw new Error("conversation destination mismatch");
            }
            if (content?.contentType !== 2 || !(content.content instanceof Uint8Array)) {
              throw new Error("chat content mismatch");
            }
            const envelope = new Uint8Array([9, 8, 7]);
            const protobuf = new Uint8Array([0x22, envelope.length, ...envelope]);
            captured.push({
              url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage",
              method: "POST",
              body: grpcDataFrame(protobuf),
            });
            await callRemote(callback, ["onQueued"]);
          },
        },
      }),
    },
  }),
  destroyWasm: () => undefined,
  stop: () => undefined,
});

parentPort.postMessage({ __officialHostReady: true });

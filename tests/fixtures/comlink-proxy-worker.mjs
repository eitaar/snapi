import { MessageChannel, parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("fixture requires parentPort");

let nextId = 1;

function callRemote(endpoint, path, args = []) {
  const id = `fixture-${nextId++}`;
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      endpoint.off("message", onMessage);
      if (message.type === "RAW") resolve(message.value);
      else reject(new Error("fixture remote call failed"));
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
    const handler = handlers[path];
    if (handler === undefined) {
      endpoint.postMessage({ id: message.id, type: "RAW", value: undefined });
      return;
    }
    const args = (message.argumentList ?? []).map((entry) => entry.value);
    const value = await handler(...args);
    if (value?.fixtureProxy === true) {
      const { port1, port2 } = new MessageChannel();
      expose(port1, value.handlers);
      endpoint.postMessage(
        { id: message.id, type: "HANDLER", name: "proxy", value: port2 },
        [port2],
      );
      return;
    }
    endpoint.postMessage({ id: message.id, type: "RAW", value });
  });
  endpoint.start?.();
}

expose(parentPort, {
  createMessagingSession: async (delegate) => ({
    fixtureProxy: true,
    handlers: {
      getConversationManager: () => ({
        fixtureProxy: true,
        handlers: {
          echo: async (value) => `${await callRemote(delegate, ["readAccountId"])}:${value}`,
        },
      }),
    },
  }),
});

parentPort.postMessage({ __officialHostReady: true, fixtureId: nextId++ });

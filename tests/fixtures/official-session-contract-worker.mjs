import { MessageChannel, parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("fixture requires parentPort");
let nextId = 1;
let webCookieHeader;
let ssoCookieHeader;
let officialHttpToken;
let authTokenGetter;
let mcsCofSequenceIdsGetter;
let wasmLoaded = false;
const refreshedAuthExpectation = {
  webCookieHeader: "refreshed-web-cookie",
  ssoCookieHeader: "refreshed-sso-cookie",
  officialHttpToken: "refreshed-official-http-token",
  mcsCofSequenceIds: "refreshed-cof-sequence",
};

function callRemote(endpoint, path, args = []) {
  const id = `contract-${nextId++}`;
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      endpoint.off("message", onMessage);
      if (message.type === "RAW") resolve(message.value);
      else reject(new Error(message.value?.value?.message ?? "delegate failed"));
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

expose(parentPort, {
  "__host.setWebCookieHeader": async (value) => {
    webCookieHeader = value;
    return true;
  },
  "__host.setSsoCookieHeader": async (value) => {
    ssoCookieHeader = value;
    return true;
  },
  "__host.setOfficialHttpToken": async (value) => {
    officialHttpToken = value;
    return true;
  },
  "__host.setOfficialGatewayToken": async (value) => {
    officialGatewayToken = value;
    return true;
  },
  "__host.syncFriends": async () => ({
    ...(wasmLoaded ? await (async () => {
      const authToken = authTokenGetter === undefined
        ? undefined
        : await callRemote(authTokenGetter, ["apply"], [undefined, []]);
      const mcsCofSequenceIds = mcsCofSequenceIdsGetter === undefined
        ? undefined
        : await callRemote(mcsCofSequenceIdsGetter, ["apply"], [undefined, []]);
      if (
        webCookieHeader !== refreshedAuthExpectation.webCookieHeader ||
        ssoCookieHeader !== refreshedAuthExpectation.ssoCookieHeader ||
        officialHttpToken !== refreshedAuthExpectation.officialHttpToken ||
        authToken !== "refreshed-official-gateway-token" ||
        mcsCofSequenceIds !== refreshedAuthExpectation.mcsCofSequenceIds
      ) {
        throw new Error("official auth state was not refreshed before the read-only operation");
      }
      return {
        syncedAt: "2026-08-12T00:00:00.000Z",
        status: "success",
        friends: [],
        incomingRequests: [],
      };
    })() : {
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success",
      friends: [],
      incomingRequests: [],
    }),
  }),
  setAuthTokenGetter: async (value) => {
    authTokenGetter = value;
    return true;
  },
  setMcsCofSequenceIdsGetter: async (value) => {
    mcsCofSequenceIdsGetter = value;
    return true;
  },
  loadWasm: async () => {
    wasmLoaded = true;
    return undefined;
  },
  createMessagingSession: async (...args) => {
    if (args.length !== 18) throw new Error("expected 18 messaging arguments");
    if (!(args[0]?.userId?.id instanceof Uint8Array) || args[0].userId.id.length !== 16) {
      throw new Error("invalid config user id");
    }
    if (args[15]?.str !== "11111111-1111-4111-8111-111111111111") {
      throw new Error("invalid raw user id");
    }
    const rootKey = await callRemote(args[7], ["get", "apply"], [undefined, []]);
    const temporaryKey = await callRemote(args[9], ["getItem", "apply"], [undefined, ["e2eeTempKey"]]);
    if (rootKey === undefined) {
      if (temporaryKey !== "opaque serialized temporary identity") {
        throw new Error("temporary identity key was not restored");
      }
    } else if (rootKey?.rwk?.data?.length !== 3 || rootKey?.keyIdentifier?.data?.length !== 3) {
      throw new Error("persisted root wrapping key was not restored");
    }
    const devices = await callRemote(args[10], ["apply"], [undefined, [args[15]]]);
    if (!Array.isArray(devices) || devices[0]?.deviceId !== "device-1") {
      throw new Error("friend devices were not restored");
    }
    const keyInfo = await callRemote(args[11], ["apply"], [undefined, []]);
    if (!(keyInfo instanceof Uint8Array) || keyInfo.join(",") !== "1,2,3") {
      throw new Error("key initialization info was not restored");
    }
    await callRemote(args[7], ["set", "apply"], [undefined, [{
      rwk: { data: new Uint8Array([9, 9, 9]) },
      keyIdentifier: { data: new Uint8Array([8, 8]) },
    }]]);
    await callRemote(args[8], ["setItem", "apply"], [undefined, ["identity-state", "persisted"]]);
    await callRemote(args[9], ["removeItem", "apply"], [undefined, ["e2eeTempKey"]]);
    await callRemote(args[9], ["setItem", "apply"], [undefined, ["session-state", "persisted"]]);
    await callRemote(args[6], ["apply"], [undefined, [{
      messageId: "received-message",
      conversationId: "received-conversation",
      senderId: "received-sender",
    }]]);
    return {
      fixtureProxy: true,
      handlers: {
        getConversationManager: () => ({
          fixtureProxy: true,
          handlers: {
            ready: () => true,
            getOneOnOneConversationIds: async (users, callback) => {
              await callRemote(callback, ["onSuccess", "apply"], [undefined, [[{
                userId: users[0],
                conversationId: { str: "22222222-2222-4222-8222-222222222222" },
              }]]]);
            },
          },
        }),
        getFeedManager: () => ({
          fixtureProxy: true,
          handlers: {
            syncFeed: async (reason) => {
              await callRemote(args[2], ["onFeedEntriesUpdated", "apply"], [undefined, [[{
                id: "feed-entry",
                content: { text: "received plaintext" },
              }], "conversation", reason, false]]);
            },
          },
        }),
      },
    };
  },
  destroyWasm: () => undefined,
  stop: () => undefined,
});

parentPort.postMessage({ __officialHostReady: true });

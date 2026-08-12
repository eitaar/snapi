import { parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("fixture requires parentPort");

parentPort.on("message", (message) => {
  if (message?.path?.[0] === "__host" && message.path[1] === "syncFriends") {
    parentPort.postMessage({
      id: message.id,
      type: "HANDLER",
      name: "throw",
      value: {
        isError: true,
        value: {
          name: "OfficialSessionExpiredError",
          message: "raw-transport-secret must not cross the boundary",
        },
      },
    });
    return;
  }
  parentPort.postMessage({ id: message.id, type: "RAW", value: true });
});

parentPort.postMessage({ __officialHostReady: true });

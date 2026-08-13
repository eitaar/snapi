import type {
  AuthBindingConclusion,
  AuthBindingContext,
  AuthBindingKind,
  AuthBindingOperation,
  SafeAuthBindingObservation,
} from "./auth-binding-types.js";

type Comparison = readonly [SafeAuthBindingObservation, SafeAuthBindingObservation];

const GATEWAY_PATH = "/snapchat.gateway.Gateway/WebSocketConnect";
const MESSAGING_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/BatchDeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
]);
const GATEWAY_CONTEXTS = new Set<AuthBindingContext>([
  "brave-natural",
  "brave-reload",
  "brave-restart",
  "node-gateway",
  "dotnet-gateway",
]);
const MESSAGING_CONTEXTS = new Set<AuthBindingContext>([
  "brave-natural",
  "brave-reload",
  "brave-restart",
  "brave-h2-natural",
  "brave-page-replay",
  "brave-worker-replay",
  "node-http1",
  "node-http2",
  "dotnet-http3",
]);

function isSuccess(observation: SafeAuthBindingObservation): boolean {
  return observation.operation === "gateway-handshake"
    ? observation.status === 101
    : observation.status !== undefined && observation.status >= 200 && observation.status < 300;
}

function isRejected(observation: SafeAuthBindingObservation): boolean {
  return observation.status === 401;
}

function hasValidContextProtocol(observation: SafeAuthBindingObservation): boolean {
  if (observation.operation === "gateway-handshake") {
    return GATEWAY_CONTEXTS.has(observation.context) &&
      observation.endpointPath === GATEWAY_PATH &&
      observation.protocol === "websocket" &&
      observation.requestBodyBytes === undefined &&
      observation.requestBodySha256 === undefined;
  }
  if (
    !MESSAGING_CONTEXTS.has(observation.context) ||
    !MESSAGING_PATHS.has(observation.endpointPath) ||
    observation.requestBodyBytes === undefined ||
    observation.requestBodySha256 === undefined ||
    !/^[a-f0-9]{64}$/i.test(observation.requestBodySha256)
  ) return false;
  switch (observation.context) {
    case "node-http1":
      return observation.protocol === "http/1.1";
    case "node-http2":
    case "brave-h2-natural":
      return observation.protocol === "h2";
    case "dotnet-http3":
      return observation.protocol === "h3";
    default:
      return observation.protocol === "h2" || observation.protocol === "h3";
  }
}

function sameHeaderNameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftNames = new Set(left);
  const rightNames = new Set(right);
  return leftNames.size === rightNames.size && [...leftNames].every((name) => rightNames.has(name));
}

function sameComparisonIdentity(
  left: SafeAuthBindingObservation,
  right: SafeAuthBindingObservation,
): boolean {
  if (
    left.operation !== right.operation ||
    left.authEpoch !== right.authEpoch ||
    !left.tokenEqualsEpochBaseline ||
    !right.tokenEqualsEpochBaseline ||
    left.endpointPath !== right.endpointPath ||
    !sameHeaderNameSet(left.safeHeaderNames, right.safeHeaderNames)
  ) return false;
  return left.operation === "gateway-handshake" || (
    left.requestBodyBytes !== undefined &&
    right.requestBodyBytes !== undefined &&
    left.requestBodySha256 !== undefined &&
    right.requestBodySha256 !== undefined &&
    left.requestBodyBytes === right.requestBodyBytes &&
    left.requestBodySha256 === right.requestBodySha256
  );
}

function controlledRoute(pair: Comparison): boolean {
  return pair[0].networkRouteEqualsBaseline === true && pair[1].networkRouteEqualsBaseline === true;
}

function controlledBrowserProcess(pair: Comparison): boolean {
  return pair[0].browserProcessEqualsPrevious === true && pair[1].browserProcessEqualsPrevious === true;
}

function sameProtocol(pair: Comparison): boolean {
  return pair[0].protocol !== undefined && pair[0].protocol === pair[1].protocol;
}

function hasContexts(
  pair: Comparison,
  successContext: AuthBindingContext,
  rejectedContext: AuthBindingContext,
): boolean {
  return pair[0].context === successContext && pair[1].context === rejectedContext;
}

function comparisons(observations: readonly SafeAuthBindingObservation[]): readonly Comparison[] {
  return observations.flatMap((success) =>
    isSuccess(success)
      ? observations.flatMap((rejected) =>
        isRejected(rejected) && sameComparisonIdentity(success, rejected)
          ? [[success, rejected] as const]
          : [],
      )
      : [],
  );
}

function conclusion(
  kind: AuthBindingKind,
  evidence: readonly SafeAuthBindingObservation[],
  reason: string,
  operation?: AuthBindingOperation | "mixed",
): AuthBindingConclusion {
  const operations = new Set(evidence.map((observation) => observation.operation));
  return {
    kind,
    operation: operation ?? (operations.size === 1 ? evidence[0]!.operation : "mixed"),
    evidenceContexts: evidence.map((observation) => observation.context),
    reason,
  };
}

function classifyPartition(
  operation: AuthBindingOperation,
  observations: readonly SafeAuthBindingObservation[],
): AuthBindingConclusion {
  if (observations.length === 0) {
    return conclusion("insufficient-evidence", [], `No ${operation} observations were provided.`, operation);
  }
  if (!observations.every(hasValidContextProtocol)) {
    return conclusion(
      "insufficient-evidence",
      observations,
      `${operation} observations do not satisfy the context, endpoint, protocol, or body contract.`,
      operation,
    );
  }
  if (observations.every((observation) => observation.status === undefined && observation.transportError !== undefined)) {
    return conclusion("insufficient-evidence", observations, "Only transport errors were observed.", operation);
  }

  const pairs = comparisons(observations);

  const freshness = pairs.find((pair) =>
    operation === "messaging-read" &&
    hasContexts(pair, "brave-natural", "brave-page-replay") &&
    sameProtocol(pair) && controlledBrowserProcess(pair) && controlledRoute(pair),
  );
  if (freshness) {
    return conclusion(
      "token-freshness-bound",
      freshness,
      "A natural browser request succeeded while its same-context page replay was rejected.",
    );
  }

  const connection = pairs.find((pair) =>
    operation === "gateway-handshake" &&
    hasContexts(pair, "brave-natural", "brave-reload") &&
    pair[0].protocol === "websocket" && pair[1].protocol === "websocket" &&
    pair[0].connectionEqualsPrevious === true && pair[1].connectionEqualsPrevious === false &&
    controlledBrowserProcess(pair) && controlledRoute(pair),
  );
  if (connection) {
    return conclusion(
      "connection-instance-bound",
      connection,
      "The browser Gateway baseline succeeded and an otherwise controlled reload connection was rejected.",
    );
  }

  const process = pairs.find((pair) =>
    hasContexts(pair, "brave-reload", "brave-restart") &&
    sameProtocol(pair) && controlledRoute(pair) &&
    pair[0].connectionEqualsPrevious === false && pair[1].connectionEqualsPrevious === false &&
    pair[0].browserProcessEqualsPrevious === true && pair[1].browserProcessEqualsPrevious === false,
  );
  if (process) {
    return conclusion(
      "browser-process-or-profile-bound",
      process,
      "A controlled new connection succeeded before restart and was rejected after the browser process changed.",
    );
  }

  const http3 = pairs.find((pair) =>
    operation === "messaging-read" &&
    hasContexts(pair, "brave-natural", "brave-h2-natural") &&
    pair[0].protocol === "h3" && pair[1].protocol === "h2" && controlledRoute(pair),
  );
  if (http3) {
    return conclusion("http3-quic-bound", http3, "Controlled browser traffic succeeded over h3 and was rejected over h2.");
  }

  const tls = pairs.find((pair) =>
    operation === "messaging-read" &&
    hasContexts(pair, "brave-h2-natural", "node-http2") &&
    pair[0].protocol === "h2" && pair[1].protocol === "h2" && controlledRoute(pair),
  );
  if (tls) {
    return conclusion("tls-client-bound", tls, "Browser and Node h2 requests differed on the same recorded network route.");
  }

  const principal = pairs.find((pair) =>
    operation === "messaging-read" &&
    hasContexts(pair, "brave-worker-replay", "brave-page-replay") &&
    sameProtocol(pair) && controlledBrowserProcess(pair) && controlledRoute(pair),
  );
  if (principal) {
    return conclusion("browser-principal-bound", principal, "Worker replay succeeded while the controlled page replay was rejected.");
  }

  const bootstrap = pairs.find((pair) =>
    operation === "messaging-read" &&
    pair[0].context === pair[1].context &&
    pair[0].bootstrapStage === "complete" && pair[1].bootstrapStage === "incomplete" &&
    sameProtocol(pair) && controlledBrowserProcess(pair) && controlledRoute(pair),
  );
  if (bootstrap) {
    return conclusion("bootstrap-sequence-bound", bootstrap, "The exact complete bootstrap label succeeded and incomplete label was rejected.");
  }

  const serverBinding = pairs.find((pair) =>
    pair[0].context.startsWith("brave-") && !pair[1].context.startsWith("brave-") &&
    controlledRoute(pair) && sameProtocol(pair) &&
    pair[0].connectionEqualsPrevious === true && pair[1].connectionEqualsPrevious === true &&
    pair[0].browserProcessEqualsPrevious === true && pair[1].browserProcessEqualsPrevious === true &&
    pair[0].bootstrapStage === "complete" && pair[1].bootstrapStage === "complete",
  );
  if (serverBinding) {
    return conclusion(
      "server-side-browser-binding",
      serverBinding,
      "All recorded client-visible controls matched while only the non-browser request was rejected.",
    );
  }

  return conclusion(
    "insufficient-evidence",
    observations,
    "No paired evidence supports a narrower binding classification.",
    operation,
  );
}

export function classifyAuthBinding(
  observations: readonly SafeAuthBindingObservation[],
): AuthBindingConclusion {
  if (observations.length === 0) {
    return conclusion("insufficient-evidence", [], "No observations were provided.", "mixed");
  }

  const results = (["messaging-read", "gateway-handshake"] as const).map((operation) =>
    classifyPartition(operation, observations.filter((observation) => observation.operation === operation)),
  );
  const supported = results.filter((result) => result.kind !== "insufficient-evidence");
  if (supported.length === 1) return supported[0]!;
  if (supported.length > 1 && supported.every((result) => result.kind === supported[0]!.kind)) {
    return {
      kind: supported[0]!.kind,
      operation: "mixed",
      evidenceContexts: supported.flatMap((result) => result.evidenceContexts),
      reason: `Both operation partitions independently support ${supported[0]!.kind}.`,
    };
  }
  if (supported.length > 1) {
    return conclusion(
      "insufficient-evidence",
      observations,
      "Gateway and Messaging partitions support different conclusions.",
      "mixed",
    );
  }

  const presentOperations = new Set(observations.map((observation) => observation.operation));
  const operation = presentOperations.size === 1 ? observations[0]!.operation : "mixed";
  return conclusion(
    "insufficient-evidence",
    observations,
    results.filter((result) => presentOperations.has(result.operation as AuthBindingOperation))
      .map((result) => result.reason).join(" "),
    operation,
  );
}

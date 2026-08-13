import type {
  AuthBindingConclusion,
  AuthBindingContext,
  AuthBindingKind,
  AuthBindingOperation,
  SafeAuthBindingObservation,
} from "./auth-binding-types.js";

type Comparison = readonly [SafeAuthBindingObservation, SafeAuthBindingObservation];

function isSuccess(observation: SafeAuthBindingObservation): boolean {
  return observation.status === 101 || (observation.status !== undefined && observation.status >= 200 && observation.status < 300);
}

function isRejected(observation: SafeAuthBindingObservation): boolean {
  return observation.status === 401;
}

function sameBody(
  left: SafeAuthBindingObservation,
  right: SafeAuthBindingObservation,
): boolean {
  return left.authEpoch === right.authEpoch &&
    left.tokenEqualsEpochBaseline &&
    right.tokenEqualsEpochBaseline &&
    left.requestBodyBytes === right.requestBodyBytes &&
    left.requestBodySha256 === right.requestBodySha256;
}

function comparisons(observations: readonly SafeAuthBindingObservation[]): readonly Comparison[] {
  return observations.flatMap((success) =>
    isSuccess(success)
      ? observations.flatMap((rejected) =>
        isRejected(rejected) && success.operation === rejected.operation && sameBody(success, rejected)
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
): AuthBindingConclusion {
  const operations = new Set(evidence.map((observation) => observation.operation));
  return {
    kind,
    operation: operations.size === 1 ? evidence[0]!.operation : "mixed",
    evidenceContexts: evidence.map((observation) => observation.context),
    reason,
  };
}

function hasContexts(
  pair: Comparison,
  successContext: AuthBindingContext,
  rejectedContext: AuthBindingContext,
): boolean {
  return pair[0].context === successContext && pair[1].context === rejectedContext;
}

export function classifyAuthBinding(
  observations: readonly SafeAuthBindingObservation[],
): AuthBindingConclusion {
  if (observations.length === 0) {
    return conclusion("insufficient-evidence", [], "No observations were provided.");
  }

  const baseline = observations[0]!;
  if (!observations.every((observation) => sameBody(baseline, observation))) {
    return conclusion("insufficient-evidence", observations, "Auth epoch, baseline token identity, or request body identity differs.");
  }

  if (observations.every((observation) => observation.status === undefined && observation.transportError !== undefined)) {
    return conclusion("insufficient-evidence", observations, "Only transport errors were observed.");
  }

  const pairs = comparisons(observations);
  const freshness = pairs.find((pair) => hasContexts(pair, "brave-natural", "brave-reload"));
  if (freshness) {
    return conclusion("token-freshness-bound", freshness, "A fresh browser request succeeded while its reload replay was rejected.");
  }

  const connection = pairs.find(([success, rejected]) =>
    success.connectionEqualsPrevious === true && rejected.connectionEqualsPrevious === false,
  );
  if (connection) {
    return conclusion("connection-instance-bound", connection, "The same auth epoch was rejected only after the connection changed.");
  }

  const process = pairs.find(([success, rejected]) =>
    success.browserProcessEqualsPrevious === true && rejected.browserProcessEqualsPrevious === false,
  );
  if (process) {
    return conclusion("browser-process-or-profile-bound", process, "The same auth epoch was rejected only after the browser process or profile changed.");
  }

  const http3 = pairs.find((pair) =>
    hasContexts(pair, "brave-natural", "brave-h2-natural") && pair[0].protocol === "h3" && pair[1].protocol === "h2",
  );
  if (http3) {
    return conclusion("http3-quic-bound", http3, "The browser request succeeded over h3 and was rejected over h2.");
  }

  const tls = pairs.find((pair) =>
    hasContexts(pair, "brave-h2-natural", "node-http2") && pair[0].protocol === "h2" && pair[1].protocol === "h2",
  );
  if (tls) {
    return conclusion("tls-client-bound", tls, "Browser and Node h2 requests differed despite identical safe request identity.");
  }

  const principal = pairs.find((pair) => hasContexts(pair, "brave-page-replay", "brave-worker-replay"));
  if (principal) {
    return conclusion("browser-principal-bound", principal, "Page and Worker replay contexts produced different authorization results.");
  }

  const bootstrap = pairs.find(([success, rejected]) =>
    success.bootstrapStage !== undefined && rejected.bootstrapStage !== undefined && success.bootstrapStage !== rejected.bootstrapStage,
  );
  if (bootstrap) {
    return conclusion("bootstrap-sequence-bound", bootstrap, "Authorization differed after a change in bootstrap stage.");
  }

  const serverBinding = pairs.find(([success, rejected]) =>
    success.networkRouteEqualsBaseline === true && rejected.networkRouteEqualsBaseline === true &&
    success.connectionEqualsPrevious === true && rejected.connectionEqualsPrevious === true &&
    success.browserProcessEqualsPrevious === true && rejected.browserProcessEqualsPrevious === true &&
    success.protocol === rejected.protocol && success.bootstrapStage === rejected.bootstrapStage,
  );
  if (serverBinding) {
    return conclusion("server-side-browser-binding", serverBinding, "All recorded client-visible differences were controlled without explaining the rejection.");
  }

  return conclusion("insufficient-evidence", observations, "No paired evidence supports a narrower binding classification.");
}

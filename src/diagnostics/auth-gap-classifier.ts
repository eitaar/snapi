import type {
  AuthGapConclusion,
  ProbeContext,
  SafeAuthGapObservation,
} from "./auth-gap-types.js";

function isSuccess(observation: SafeAuthGapObservation | undefined): boolean {
  return observation?.status !== undefined && observation.status >= 200 && observation.status < 300;
}

function isStatus(
  observation: SafeAuthGapObservation | undefined,
  status: number,
): boolean {
  return observation?.status === status;
}

function findUnique(
  observations: readonly SafeAuthGapObservation[],
  context: ProbeContext,
): SafeAuthGapObservation | undefined {
  const matches = observations.filter((observation) => observation.context === context);
  return matches.length === 1 ? matches[0] : undefined;
}

function comparable(
  observations: readonly SafeAuthGapObservation[],
): boolean {
  if (observations.length === 0) return false;
  const first = observations[0]!;
  return observations.every((observation) =>
    observation.authEpoch === first.authEpoch &&
    observation.endpointPath === first.endpointPath &&
    observation.method === first.method &&
    observation.requestBodyBytes === first.requestBodyBytes &&
    observation.requestBodySha256 === first.requestBodySha256,
  );
}

export function classifyAuthGap(
  observations: readonly SafeAuthGapObservation[],
): AuthGapConclusion {
  if (!comparable(observations)) {
    return { kind: "insufficient-evidence", directNodeStillViable: undefined };
  }

  const nodeBearer = findUnique(observations, "node-bearer");
  const nodeWebCookie = findUnique(observations, "node-web-cookie");
  if (isStatus(nodeBearer, 401) && isSuccess(nodeWebCookie)) {
    return { kind: "web-cookie-required", directNodeStillViable: true };
  }

  const edgeOriginal = findUnique(observations, "edge-original");
  const edgeReplay = findUnique(observations, "edge-page-replay");
  if (isSuccess(edgeOriginal) && isStatus(edgeReplay, 401)) {
    return { kind: "request-freshness-or-single-use", directNodeStillViable: undefined };
  }

  const nodeHttp2 = findUnique(observations, "node-http2");
  if (isSuccess(edgeReplay) && isStatus(nodeHttp2, 401)) {
    return { kind: "browser-context-required", directNodeStillViable: false };
  }
  if (isSuccess(edgeReplay) && isSuccess(nodeHttp2)) {
    return { kind: "http2-or-tls-difference", directNodeStillViable: undefined };
  }

  return { kind: "insufficient-evidence", directNodeStillViable: undefined };
}

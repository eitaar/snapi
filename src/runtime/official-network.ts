export type OfficialFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CapturedOfficialRequest {
  readonly url: string;
  readonly method: string;
  readonly body: Uint8Array;
  readonly responseStatus?: number;
}

export interface OfficialNetworkBoundary {
  readonly fetch: OfficialFetch;
  readonly captureOnly: boolean;
  beginCaptureOnly(): void;
  drainCapturedRequests(): readonly CapturedOfficialRequest[];
}

const CAPTURE_READ_ONLY_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
]);

const CAPTURE_LOCAL_ACK_PATHS = new Set(["/graphene/web"]);

export function createGuardedOfficialFetch(
  allowNetwork: boolean | undefined,
  networkFetch: OfficialFetch,
): OfficialFetch {
  return async (input, init) => {
    if (allowNetwork !== true) {
      throw new Error("Official messaging network access is disabled");
    }
    return networkFetch(input, init);
  };
}

export function createOfficialNetworkBoundary(
  allowNetwork: boolean | undefined,
  networkFetch: OfficialFetch,
): OfficialNetworkBoundary {
  let captureOnly = false;
  const captured: CapturedOfficialRequest[] = [];
  return {
    get captureOnly() { return captureOnly; },
    beginCaptureOnly() {
      captureOnly = true;
    },
    async fetch(input, init) {
      if (captureOnly) {
        const request = new Request(input, init);
        const capturedRequest: CapturedOfficialRequest = {
          url: request.url,
          method: request.method,
          body: new Uint8Array(await request.clone().arrayBuffer()),
        };
        if (
          request.method === "POST" &&
          CAPTURE_READ_ONLY_PATHS.has(new URL(request.url).pathname)
        ) {
          if (allowNetwork !== true) {
            captured.push(capturedRequest);
            throw new Error("Official messaging network access is disabled");
          }
          const response = await networkFetch(request);
          captured.push({ ...capturedRequest, responseStatus: response.status });
          return response;
        }
        if (request.method === "POST" && CAPTURE_LOCAL_ACK_PATHS.has(new URL(request.url).pathname)) {
          captured.push({ ...capturedRequest, responseStatus: 200 });
          return new Response(null, { status: 200 });
        }
        captured.push(capturedRequest);
        throw new Error("Official messaging request was captured and blocked");
      }
      if (allowNetwork !== true) {
        throw new Error("Official messaging network access is disabled");
      }
      return networkFetch(input, init);
    },
    drainCapturedRequests() {
      return captured.splice(0, captured.length);
    },
  };
}

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

export interface ObservedOfficialRequest {
  readonly path: string;
  readonly method: string;
  readonly responseStatus?: number;
  readonly errorName?: string;
  readonly errorCode?: string;
  readonly errorReason?: string;
}

export interface OfficialNetworkBoundary {
  readonly fetch: OfficialFetch;
  readonly captureOnly: boolean;
  beginCaptureOnly(): void;
  drainCapturedRequests(): readonly CapturedOfficialRequest[];
  drainObservedRequests(): readonly ObservedOfficialRequest[];
}

export interface OfficialNetworkCredentials {
  readonly webCookieHeader: () => string | undefined;
  readonly ssoCookieHeader?: () => string | undefined;
}

const CAPTURE_READ_ONLY_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
]);

const CAPTURE_LOCAL_ACK_PATHS = new Set(["/graphene/web"]);

const WEB_COOKIE_PATHS = new Set([
  ...CAPTURE_READ_ONLY_PATHS,
  "/com.snapchat.deltaforce.external.DeltaForce/DeltaSync",
  "/api/158/envelope/",
  "/com.snapchat.atlas.gw.AtlasGw/SyncFriendData",
  "/snapchat.friending.server.FriendRequests/IncomingFriendSync",
]);
const MAX_OBSERVED_REQUESTS = 256;

function pushObserved(
  observed: ObservedOfficialRequest[],
  value: ObservedOfficialRequest,
): void {
  if (observed.length === MAX_OBSERVED_REQUESTS) observed.shift();
  observed.push(value);
}

function safeErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { readonly code?: unknown; readonly cause?: unknown };
  const cause = candidate.cause !== null && typeof candidate.cause === "object"
    ? candidate.cause as { readonly code?: unknown }
    : undefined;
  const code = typeof candidate.code === "string"
    ? candidate.code
    : typeof cause?.code === "string" ? cause.code : undefined;
  return code !== undefined && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : undefined;
}

function safeErrorReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (/duplex option is required/i.test(error.message)) return "request-duplex-required";
  if (/body is unusable|disturbed or locked|already been used/i.test(error.message)) {
    return "request-body-unusable";
  }
  if (/GET\/HEAD method cannot have body/i.test(error.message)) return "unexpected-request-body";
  if (error.message === "fetch failed") return "fetch-failed";
  return undefined;
}

function withCookie(
  request: Request,
  credentials: OfficialNetworkCredentials | undefined,
): Request | undefined {
  if (request.method !== "POST") return undefined;
  const url = new URL(request.url);
  const isWebContext = url.origin === "https://web.snapchat.com" && WEB_COOKIE_PATHS.has(url.pathname);
  const isSsoContext = url.origin === "https://accounts.snapchat.com" && url.pathname === "/accounts/sso";
  if (!isWebContext && !isSsoContext) return undefined;
  const headers = new Headers(request.headers);
  if (!headers.has("cookie") && credentials !== undefined) {
    const cookie = isWebContext
      ? credentials.webCookieHeader()
      : credentials.ssoCookieHeader?.();
    if (cookie !== undefined && cookie.trim() !== "") headers.set("cookie", cookie);
  }
  if (headers.get("cookie") === request.headers.get("cookie")) return undefined;
  return new Request(request, { headers });
}

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
  credentials?: OfficialNetworkCredentials,
): OfficialNetworkBoundary {
  let captureOnly = false;
  const captured: CapturedOfficialRequest[] = [];
  const observed: ObservedOfficialRequest[] = [];
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
          const response = await networkFetch(withCookie(request, credentials) ?? request);
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
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url;
      const requestMethod = (init?.method ?? (input instanceof Request ? input.method : "GET"))
        .toUpperCase();
      const path = (() => {
        const url = new URL(requestUrl);
        return `${url.origin}${url.pathname}`;
      })();
      try {
        let networkInput = input;
        let networkInit = init;
        if (credentials !== undefined) {
          const request = input instanceof Request ? input.clone() : new Request(input, init);
          const requestWithCookie = withCookie(request, credentials);
          if (requestWithCookie !== undefined) {
            networkInput = requestWithCookie;
            networkInit = undefined;
          }
        }
        const response = await networkFetch(networkInput, networkInit);
        pushObserved(observed, { path, method: requestMethod, responseStatus: response.status });
        return response;
      } catch (error) {
        const errorCode = safeErrorCode(error);
        const errorReason = safeErrorReason(error);
        pushObserved(observed, {
          path,
          method: requestMethod,
          errorName: error instanceof Error ? error.name : "UnknownError",
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(errorReason === undefined ? {} : { errorReason }),
        });
        throw error;
      }
    },
    drainCapturedRequests() {
      return captured.splice(0, captured.length);
    },
    drainObservedRequests() {
      return observed.splice(0, observed.length);
    },
  };
}

import { AppError } from "../errors.js";
import type { SessionExport } from "../session/types.js";

const SSO_URL = "https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod";
const SESSION_REFRESH_URL =
  "https://web.snapchat.com/web-chat-session/refresh?client_id=web-calling-corp--prod";
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{64,8192}$/;
const WEB_SESSION_MAX_AGE_MS = 3_600_000;

export interface SsoRefreshDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly attestation?: (session: SessionExport) => Promise<string>;
}

function cookieEntries(cookieHeader: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return entries;
}

function mergeSetCookies(cookieHeader: string, setCookies: readonly string[]): string {
  const entries = cookieEntries(cookieHeader);
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0]?.trim() ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === "") entries.delete(name);
    else entries.set(name, value);
  }
  return [...entries].map(([name, value]) => `${name}=${value}`).join("; ");
}

function responseSetCookies(headers: Headers): readonly string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === "function") return getter.call(headers);
  const combined = headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function redirectMetadata(
  response: Response,
  baseUrl: string,
): Readonly<Record<string, unknown>> {
  const location = response.headers.get("location");
  if (location === null) return { hasLocation: false };
  try {
    const url = new URL(location, baseUrl);
    return {
      hasLocation: true,
      locationOrigin: url.origin,
      locationPath: url.pathname,
      locationQueryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      locationHasCode: url.searchParams.has("code"),
      locationHasError: url.searchParams.has("error"),
    };
  } catch {
    return { hasLocation: true, locationInvalid: true };
  }
}

export async function refreshSnapchatWebSession(
  session: SessionExport,
  dependencies: SsoRefreshDependencies = {},
): Promise<SessionExport> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const capturedHeaders = session.auth.webSessionRequestHeaders
    ?? session.auth.ssoRequestHeaders;
  const headers: Record<string, string> = {
    ...(capturedHeaders ?? {}),
    accept: "*/*",
    authorization: `Bearer ${session.auth.httpToken}`,
    "cache-control": "no-cache",
    cookie: session.auth.cookieHeader,
    origin: capturedHeaders?.origin ?? "https://www.snapchat.com",
    pragma: "no-cache",
    referer: capturedHeaders?.referer ?? "https://www.snapchat.com/",
  };
  const clientUserAgent = capturedHeaders?.["x-snap-client-user-agent"]
    ?? session.auth.requestHeaders["x-snap-client-user-agent"];
  if (clientUserAgent !== undefined) headers["x-snap-client-user-agent"] = clientUserAgent;
  let response: Response;
  try {
    response = await fetch(SESSION_REFRESH_URL, {
      method: "POST",
      body: null,
      redirect: "manual",
      headers,
    });
  } catch (error) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Unable to refresh the exported Web session", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  if (
    response.type === "opaqueredirect"
    || (response.status >= 300 && response.status < 400)
    || response.status === 403
  ) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Exported Snapchat authentication no longer accepts a Web session heartbeat",
      {
        status: response.status,
        ...redirectMetadata(response, SESSION_REFRESH_URL),
      },
    );
  }

  if (!response.ok) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Exported Snapchat authentication can no longer refresh the Web session", {
      status: response.status,
    });
  }

  const refreshedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  return {
    ...session,
    exportedAt: refreshedAt,
    auth: {
      ...session.auth,
      cookieHeader: mergeSetCookies(
        session.auth.cookieHeader,
        responseSetCookies(response.headers),
      ),
      webSessionRefreshedAt: refreshedAt,
    },
  };
}

export async function refreshSnapchatSso(
  session: SessionExport,
  dependencies: SsoRefreshDependencies = {},
): Promise<SessionExport> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const ssoCookieHeader = session.auth.ssoCookieHeader;
  if (ssoCookieHeader === undefined) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Session export is missing the accounts-domain SSO cookie",
    );
  }
  const capturedHeaders = session.auth.ssoRequestHeaders;
  const attestation = await dependencies.attestation?.(session);
  const headers: Record<string, string> = {
    ...(capturedHeaders ?? {}),
    accept: "*/*",
    "cache-control": "no-cache",
    cookie: ssoCookieHeader,
    origin: capturedHeaders?.origin ?? "https://www.snapchat.com",
    pragma: "no-cache",
    referer: capturedHeaders?.referer ?? "https://www.snapchat.com/",
  };
  if (attestation !== undefined) headers["snap-att"] = attestation;
  if (session.auth.ssoScuid !== undefined) headers.scuid = session.auth.ssoScuid;

  let response: Response;
  try {
    response = await fetch(SSO_URL, {
      method: "POST",
      body: null,
      redirect: "manual",
      headers,
    });
  } catch (error) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Unable to refresh the exported Snapchat token", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  if (
    response.type === "opaqueredirect"
    || (response.status >= 300 && response.status < 400)
    || response.status === 403
  ) {
    throw new AppError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "SSO token refresh requires a valid exported authentication context",
      {
        status: response.status,
        hasAttestation: attestation !== undefined,
        ...redirectMetadata(response, SSO_URL),
      },
    );
  }
  if (!response.ok) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Exported Snapchat authentication can no longer refresh the token", {
      status: response.status,
    });
  }

  const token = (await response.text()).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "SSO refresh returned an invalid token");
  }
  const responseAccountId = response.headers.get("scuid")?.toLowerCase();
  if (responseAccountId !== undefined && responseAccountId !== session.accountId.toLowerCase()) {
    throw new AppError("INVALID_SESSION_EXPORT", "SSO refresh account does not match the session export");
  }
  const refreshedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  return {
    ...session,
    exportedAt: refreshedAt,
    auth: {
      ...session.auth,
      httpToken: token,
      gatewayToken: token,
      tokenRefreshedAt: refreshedAt,
      ssoCookieHeader: mergeSetCookies(ssoCookieHeader, responseSetCookies(response.headers)),
    },
  };
}

export async function refreshSnapchatSession(
  session: SessionExport,
  dependencies: SsoRefreshDependencies = {},
): Promise<SessionExport> {
  const refreshed = await refreshSnapchatSso(session, dependencies);
  const now = dependencies.now ?? (() => new Date());
  const heartbeatAt = Date.parse(
    session.auth.webSessionRefreshedAt ?? session.exportedAt,
  );
  if (!Number.isNaN(heartbeatAt) && now().getTime() - heartbeatAt < WEB_SESSION_MAX_AGE_MS) {
    return refreshed;
  }
  return refreshSnapchatWebSession(refreshed, dependencies);
}

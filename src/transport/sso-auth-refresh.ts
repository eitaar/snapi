import { AppError } from "../errors.js";
import type { SessionExport } from "../session/types.js";

const SSO_URL = "https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod";
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{64,8192}$/;

export interface SsoRefreshDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
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

export async function refreshSnapchatSso(
  session: SessionExport,
  dependencies: SsoRefreshDependencies = {},
): Promise<SessionExport> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const ssoCookieHeader = session.auth.ssoCookieHeader;
  const ssoScuid = session.auth.ssoScuid;
  if (ssoCookieHeader === undefined) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Session export is missing the accounts-domain SSO cookie",
    );
  }
  if (ssoScuid === undefined) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Session export is missing the accounts-domain SSO client identifier",
    );
  }
  let response: Response;
  try {
    response = await fetch(SSO_URL, {
      method: "POST",
      body: null,
      headers: {
        accept: "*/*",
        "cache-control": "no-cache",
        cookie: ssoCookieHeader,
        origin: "https://web.snapchat.com",
        pragma: "no-cache",
        referer: "https://web.snapchat.com/",
        scuid: ssoScuid,
      },
    });
  } catch (error) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Unable to refresh the exported Snapchat session", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  if (!response.ok) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Exported Snapchat cookies can no longer refresh authentication", {
      status: response.status,
    });
  }

  const token = (await response.text()).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "SSO refresh returned an invalid token");
  }

  const responseAccountId = response.headers.get("scuid")?.toLowerCase();
  if (responseAccountId !== session.accountId.toLowerCase()) {
    throw new AppError(
      "INVALID_SESSION_EXPORT",
      "SSO refresh account does not match the session export",
    );
  }

  return {
    ...session,
    exportedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    auth: {
      ...session.auth,
      httpToken: token,
      gatewayToken: token,
      ssoCookieHeader: mergeSetCookies(
        ssoCookieHeader,
        responseSetCookies(response.headers),
      ),
    },
  };
}

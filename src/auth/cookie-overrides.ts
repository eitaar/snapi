import type { SessionExport } from "../session/types.js";

export interface CookieOverrides {
  readonly cookieHeader?: string;
  readonly ssoCookieHeader?: string;
}

export function applyCookieOverrides(
  session: SessionExport,
  overrides: CookieOverrides,
): SessionExport {
  if (overrides.cookieHeader === undefined && overrides.ssoCookieHeader === undefined) return session;
  return {
    ...session,
    auth: {
      ...session.auth,
      ...(overrides.cookieHeader === undefined ? {} : { cookieHeader: overrides.cookieHeader }),
      ...(overrides.ssoCookieHeader === undefined ? {} : { ssoCookieHeader: overrides.ssoCookieHeader }),
    },
  };
}

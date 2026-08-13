export interface CookieJarOptions {
  readonly now?: () => number;
}

interface StoredCookie {
  readonly name: string;
  value: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly secure: boolean;
  expiresAt?: number;
  readonly createdAt: number;
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  if (hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function responseCookies(response: Response | readonly string[]): readonly string[] {
  if (typeof response !== "object" || response === null || !("headers" in response)) {
    return response as readonly string[];
  }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const getter = headers.getSetCookie;
  if (typeof getter === "function") return getter.call(headers);
  const combined = headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function parsePair(value: string): { readonly name: string; readonly value: string } | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0) return undefined;
  const name = value.slice(0, separator).trim();
  if (name === "") return undefined;
  return { name, value: value.slice(separator + 1).trim() };
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: CookieJarOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  mergeHeader(origin: string, cookieHeader: string): this {
    const url = new URL(origin);
    const domain = url.hostname.toLowerCase();
    // An exported Cookie header has no Path metadata. Treat it as a host-wide
    // session cookie so a later Set-Cookie with Path=/ replaces it cleanly.
    const path = "/";
    for (const part of cookieHeader.split(";")) {
      const pair = parsePair(part.trim());
      if (pair === undefined) continue;
      this.store({
        ...pair,
        domain,
        path,
        hostOnly: true,
        secure: false,
        createdAt: this.sequence++,
      });
    }
    return this;
  }

  setFromResponse(origin: string, response: Response | readonly string[]): this {
    const url = new URL(origin);
    const requestHost = url.hostname.toLowerCase();
    const requestPath = url.pathname;
    const now = this.now();
    for (const raw of responseCookies(response)) {
      const parts = raw.split(";");
      const pair = parsePair(parts.shift()?.trim() ?? "");
      if (pair === undefined) continue;

      let domain = requestHost;
      let hostOnly = true;
      let path = defaultPath(requestPath);
      let secure = false;
      let expiresAt: number | undefined;
      let maxAge: number | undefined;
      for (const attribute of parts) {
        const parsed = parsePair(attribute.trim());
        const name = (parsed?.name ?? attribute.trim()).toLowerCase();
        const attributeValue = parsed?.value ?? "";
        if (name === "domain" && attributeValue !== "") {
          const candidate = attributeValue.replace(/^\./, "").toLowerCase();
          if (!domainMatches(requestHost, candidate, false)) continue;
          domain = candidate;
          hostOnly = false;
        } else if (name === "path" && attributeValue.startsWith("/")) {
          path = attributeValue;
        } else if (name === "secure") {
          secure = true;
        } else if (name === "max-age") {
          const parsedAge = Number(attributeValue);
          if (Number.isFinite(parsedAge)) maxAge = parsedAge;
        } else if (name === "expires") {
          const parsedDate = Date.parse(attributeValue);
          if (!Number.isNaN(parsedDate)) expiresAt = parsedDate;
        }
      }
      if (maxAge !== undefined) expiresAt = maxAge <= 0 ? now : now + maxAge * 1000;
      const cookie: StoredCookie = {
        ...pair,
        domain,
        path,
        hostOnly,
        secure,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        createdAt: this.sequence++,
      };
      this.store(cookie);
    }
    return this;
  }

  headerFor(urlValue: string): string {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    const now = this.now();
    const matching: StoredCookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (
        domainMatches(host, cookie.domain, cookie.hostOnly)
        && pathMatches(path, cookie.path)
        && (!cookie.secure || url.protocol === "https:")
      ) {
        matching.push(cookie);
      }
    }
    matching.sort((left, right) => right.path.length - left.path.length || left.createdAt - right.createdAt);
    return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  private store(cookie: StoredCookie): void {
    const key = `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= this.now()) {
      this.cookies.delete(key);
      return;
    }
    const previous = this.cookies.get(key);
    this.cookies.set(key, previous === undefined ? cookie : { ...cookie, createdAt: previous.createdAt });
  }
}

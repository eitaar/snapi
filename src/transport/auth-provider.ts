import type { SessionExport } from "../session/types.js";

export interface RequestAuth {
  readonly httpToken: string;
  readonly cookieHeader: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type AuthRefreshReason =
  | { readonly kind: "expired" }
  | { readonly kind: "http"; readonly status: 401 | 403 }
  | { readonly kind: "grpc"; readonly status: 7 | 16 };

export interface AuthProviderDependencies {
  readonly refresh: (session: SessionExport) => Promise<SessionExport>;
  readonly persist?: (session: SessionExport) => Promise<void>;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

export interface RequestAuthSource {
  getRequestAuth(): Promise<RequestAuth>;
  refreshOnce(reason: AuthRefreshReason): Promise<RequestAuth>;
}

export class AuthProvider implements RequestAuthSource {
  private current: SessionExport;
  private refreshPromise: Promise<RequestAuth> | undefined;

  constructor(
    session: SessionExport,
    private readonly dependencies: AuthProviderDependencies,
  ) {
    this.current = session;
  }

  private requestAuth(): RequestAuth {
    return {
      httpToken: this.current.auth.httpToken,
      cookieHeader: this.current.auth.cookieHeader,
      headers: this.current.auth.requestHeaders,
    };
  }

  async getRequestAuth(): Promise<RequestAuth> {
    const now = this.dependencies.now ?? Date.now;
    const maxAgeMs = this.dependencies.maxAgeMs ?? 3_600_000;
    if (now() - Date.parse(this.current.exportedAt) >= maxAgeMs) {
      return this.refreshOnce({ kind: "expired" });
    }
    return this.requestAuth();
  }

  async getGatewayToken(): Promise<string> {
    await this.getRequestAuth();
    return this.current.auth.gatewayToken;
  }

  refreshOnce(_reason: AuthRefreshReason): Promise<RequestAuth> {
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const refreshed = await this.dependencies.refresh(this.current);
      await this.dependencies.persist?.(refreshed);
      this.current = refreshed;
      return this.requestAuth();
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  sessionSnapshot(): SessionExport {
    return this.current;
  }
}

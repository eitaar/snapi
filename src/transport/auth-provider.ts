import type { SessionExport } from "../session/types.js";
import { AppError } from "../errors.js";

export interface RequestAuth {
  readonly httpToken: string;
  readonly cookieHeader: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly refreshConsumed?: true;
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
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
}

export type RenewalState = "ready" | "renewing" | "backoff" | "login-required";
export type RenewalFailure = "browser-context-required" | "session-reexport-required" | "transient";

export interface RenewalStatus {
  readonly state: RenewalState;
  readonly consecutiveFailures: number;
  readonly lastFailure?: RenewalFailure;
}

export interface RequestAuthSource {
  getRequestAuth(): Promise<RequestAuth>;
  refreshOnce(reason: AuthRefreshReason): Promise<RequestAuth>;
}

export class AuthProvider implements RequestAuthSource {
  private current: SessionExport;
  private refreshPromise: Promise<RequestAuth> | undefined;
  private state: RenewalState = "ready";
  private consecutiveFailures = 0;
  private lastFailure: RenewalFailure | undefined;

  constructor(
    session: SessionExport,
    private readonly dependencies: AuthProviderDependencies,
  ) {
    this.current = session;
  }

  private requestAuth(refreshConsumed = false): RequestAuth {
    return {
      httpToken: this.current.auth.httpToken,
      cookieHeader: this.current.auth.cookieHeader,
      headers: this.current.auth.requestHeaders,
      ...(refreshConsumed ? { refreshConsumed: true as const } : {}),
    };
  }

  async getRequestAuth(): Promise<RequestAuth> {
    const now = this.dependencies.now ?? Date.now;
    const maxAgeMs = this.dependencies.maxAgeMs ?? 600_000;
    const tokenRefreshedAt = this.current.auth.tokenRefreshedAt ?? this.current.exportedAt;
    if (now() - Date.parse(tokenRefreshedAt) >= maxAgeMs) {
      return this.refreshOnce({ kind: "expired" });
    }
    return this.requestAuth();
  }

  async getGatewayToken(): Promise<string> {
    await this.getRequestAuth();
    return this.current.auth.gatewayToken;
  }

  startAutoRefresh(onError: (error: unknown) => void = () => undefined): () => void {
    const now = this.dependencies.now ?? Date.now;
    const maxAgeMs = this.dependencies.maxAgeMs ?? 600_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (retryDelayMs?: number): void => {
      if (stopped) return;
      const refreshedAt = Date.parse(
        this.current.auth.tokenRefreshedAt ?? this.current.exportedAt,
      );
      const delay = retryDelayMs ?? (
        Number.isNaN(refreshedAt)
          ? maxAgeMs
          : Math.min(maxAgeMs, Math.max(0, refreshedAt + maxAgeMs - now()))
      );
      timer = setTimeout(() => {
        void this.getRequestAuth().then(
          () => schedule(),
          (error: unknown) => {
            onError(error);
            if (this.state !== "login-required") schedule(this.nextBackoffDelay());
          },
        );
      }, delay);
      timer.unref?.();
    };

    schedule();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
  }

  refreshOnce(_reason: AuthRefreshReason): Promise<RequestAuth> {
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    this.refreshPromise = (async () => {
      this.state = "renewing";
      try {
        const refreshed = await this.dependencies.refresh(this.current);
        await this.dependencies.persist?.(refreshed);
        this.current = refreshed;
        this.state = "ready";
        this.consecutiveFailures = 0;
        this.lastFailure = undefined;
        return this.requestAuth(true);
      } catch (error) {
        this.consecutiveFailures += 1;
        this.lastFailure = this.classifyFailure(error);
        this.state = this.lastFailure === "browser-context-required" ? "login-required" : "backoff";
        throw error;
      }
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  renewalStatus(): RenewalStatus {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
    };
  }

  sessionSnapshot(): SessionExport {
    return this.current;
  }

  private nextBackoffDelay(): number {
    const initial = this.dependencies.initialBackoffMs ?? 1_000;
    const maximum = this.dependencies.maxBackoffMs ?? 300_000;
    const exponential = Math.min(
      maximum,
      initial * (2 ** Math.max(0, this.consecutiveFailures - 1)),
    );
    const random = Math.min(1, Math.max(0, this.dependencies.random?.() ?? Math.random()));
    return Math.max(1, Math.round(exponential * (0.5 + random * 0.5)));
  }

  private classifyFailure(error: unknown): RenewalFailure {
    if (error instanceof AppError) {
      const status = error.details.status;
      if (
        status === 303
        || status === 403
        || (typeof status === "number" && status >= 300 && status < 400)
      ) {
        return "browser-context-required";
      }
      if (error.code === "AUTH_CONTEXT_UNAVAILABLE") return "browser-context-required";
      if (error.code === "SESSION_REEXPORT_REQUIRED") return "session-reexport-required";
    }
    return "transient";
  }
}

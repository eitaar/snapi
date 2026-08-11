import { dirname, join } from "node:path";
import { AssetLoader } from "./compat/asset-loader.js";
import { CompatibilityGuard } from "./compat/guard.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { GatewayClient } from "./gateway/client.js";
import type { GatewayEvent, GatewayStatus } from "./gateway/events.js";
import { MessagingClient, type SendResult, type SendTextInput } from "./messaging/client.js";
import { MediaClient, type SendPhotoSnapInput } from "./media/client.js";
import { ContentRuntimeClient } from "./runtime/worker-client.js";
import { AccountLock, type AccountLockHandle } from "./session/account-lock.js";
import { loadSession } from "./session/loader.js";
import { parseSessionExport } from "./session/schema.js";
import { AtomicJsonStore } from "./session/state-store.js";
import type { SessionExport } from "./session/types.js";
import { AuthProvider } from "./transport/auth-provider.js";
import { GrpcWebClient } from "./transport/grpc-client.js";
import { refreshSnapchatSso } from "./transport/sso-auth-refresh.js";
import type { CryptoStateExport } from "./runtime/content-types.js";

interface MessagingLike {
  sendText(input: SendTextInput): Promise<SendResult>;
  messages(signal?: AbortSignal): AsyncIterableIterator<import("./messaging/client.js").ChatMessageEvent>;
}

interface MediaLike {
  sendPhotoSnap(input: SendPhotoSnapInput): Promise<SendResult>;
}

interface GatewayLike {
  connect(): Promise<void>;
  events(): AsyncIterableIterator<GatewayEvent>;
  status(): GatewayStatus;
  close(): Promise<void>;
}

interface RuntimeLike {
  shutdown(): Promise<void>;
}

export interface SnapchatClientComponents {
  readonly messaging: MessagingLike;
  readonly media: MediaLike;
  readonly gateway: GatewayLike;
  readonly runtime: RuntimeLike;
  readonly lock: AccountLockHandle;
}

export interface SnapchatClientDependencies {
  readonly compose?: (config: AppConfig) => Promise<SnapchatClientComponents>;
}

function assertConfiguredSession(config: AppConfig, session: SessionExport): void {
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  if (session.buildId !== config.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the session export");
  }
}

function mergeCryptoState(session: SessionExport, state: CryptoStateExport): SessionExport {
  return {
    ...session,
    localStorage: state.localStorage,
    sessionStorage: state.sessionStorage,
    indexedDb: state.indexedDb,
    ...(session.messaging === undefined
      ? {}
      : {
          messaging: {
            ...session.messaging,
            ...(state.rootWrappingKey === undefined
              ? {}
              : { rootWrappingKey: state.rootWrappingKey }),
          },
        }),
  };
}

async function composeDefault(config: AppConfig): Promise<SnapchatClientComponents> {
  const initialSession = await loadSession(config.sessionFile);
  assertConfiguredSession(config, initialSession);
  const lock = await new AccountLock(join(dirname(config.sessionFile), "locks")).acquire(config.accountId);
  let runtime: ContentRuntimeClient | undefined;
  try {
    await new CompatibilityGuard(new AssetLoader(config.assetDir)).verify(initialSession);
    const sessionStore = new AtomicJsonStore(config.sessionFile, parseSessionExport);
    const auth = new AuthProvider(initialSession, {
      refresh: refreshSnapchatSso,
      persist: async (refreshed) => {
        const latest = await sessionStore.read();
        await sessionStore.write({
          ...latest,
          exportedAt: refreshed.exportedAt,
          auth: refreshed.auth,
        });
      },
    });
    await auth.getRequestAuth();
    runtime = new ContentRuntimeClient({
      assetDir: config.assetDir,
      allowNetwork: true,
      timeoutMs: 90_000,
    });
    await runtime.initialize(auth.sessionSnapshot());
    const grpc = new GrpcWebClient({ auth });
    const cryptoStateStore = {
      write: async (state: CryptoStateExport) => {
        const latest = await sessionStore.read();
        await sessionStore.write(mergeCryptoState(latest, state));
      },
    };
    const messaging = new MessagingClient({ runtime, grpc, stateStore: cryptoStateStore });
    const media = new MediaClient({ runtime, grpc, stateStore: cryptoStateStore });
    const gateway = new GatewayClient({ auth });
    return { messaging, media, gateway, runtime, lock };
  } catch (error) {
    await runtime?.shutdown().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

export class SnapchatClient {
  private closed = false;

  private constructor(private readonly components: SnapchatClientComponents) {}

  static async create(
    config: AppConfig,
    dependencies: SnapchatClientDependencies = {},
  ): Promise<SnapchatClient> {
    const components = await (dependencies.compose ?? composeDefault)(config);
    return new SnapchatClient(components);
  }

  sendText(input: SendTextInput): Promise<SendResult> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Snapchat client is closed"));
    return this.components.messaging.sendText(input);
  }

  sendPhotoSnap(input: SendPhotoSnapInput): Promise<SendResult> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Snapchat client is closed"));
    return this.components.media.sendPhotoSnap(input);
  }

  async watchEvents(): Promise<AsyncIterableIterator<GatewayEvent>> {
    if (this.closed) throw new AppError("GATEWAY_DISCONNECTED", "Snapchat client is closed");
    await this.components.gateway.connect();
    return this.components.gateway.events();
  }

  watchMessages(signal?: AbortSignal): AsyncIterableIterator<import("./messaging/client.js").ChatMessageEvent> {
    if (this.closed) {
      const error = new AppError("GATEWAY_DISCONNECTED", "Snapchat client is closed");
      return (async function* () { throw error; })();
    }
    return this.components.messaging.messages(signal);
  }

  status(): GatewayStatus {
    return this.components.gateway.status();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.components.gateway.close();
    } finally {
      try {
        await this.components.runtime.shutdown();
      } finally {
        await this.components.lock.release();
      }
    }
  }
}

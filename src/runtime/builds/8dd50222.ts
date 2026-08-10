import { AppError } from "../../errors.js";
import { findUniqueModule } from "../../compat/module-scanner.js";
import type { ModuleFactory } from "../../compat/types.js";
import type { BuildAdapter, BundleContext } from "../build-adapter.js";
import type {
  AuthRefreshResult,
  ChatInput,
  ChatMessage,
  CryptoStateExport,
  EncryptedContent,
  PhotoSnapInput,
} from "../content-types.js";

interface ContentCapabilities {
  readonly initializeContentRuntime: (context: BundleContext) => Promise<void> | void;
  readonly encryptChat: (input: ChatInput) => Promise<EncryptedContent>;
  readonly decryptChat: (input: EncryptedContent) => Promise<ChatMessage>;
  readonly createPhotoSnap: (input: PhotoSnapInput) => Promise<EncryptedContent>;
  readonly refreshAuth?: () => Promise<AuthRefreshResult>;
  readonly exportState: () => Promise<CryptoStateExport>;
}

type WebpackRequire = ((id: string | number) => unknown) & {
  d: (exports: object, definitions: Readonly<Record<string, () => unknown>>) => void;
  r: (exports: object) => void;
  o: (value: object, property: PropertyKey) => boolean;
  n: (value: unknown) => (() => unknown) & { a?: () => unknown };
  g: typeof globalThis;
};

function createWebpackRequire(modules: ReadonlyMap<string, ModuleFactory>): WebpackRequire {
  const cache = new Map<string, { exports: unknown }>();
  const require = ((rawId: string | number): unknown => {
    const id = String(rawId);
    const cached = cache.get(id);
    if (cached !== undefined) return cached.exports;
    const factory = modules.get(id);
    if (factory === undefined) {
      throw new AppError("UNSUPPORTED_BUILD", "Webpack dependency is missing", { moduleId: id });
    }
    const module = { exports: {} as unknown };
    cache.set(id, module);
    factory(module, module.exports, require);
    return module.exports;
  }) as WebpackRequire;
  require.d = (exports, definitions) => {
    for (const [name, getter] of Object.entries(definitions)) {
      if (!Object.prototype.hasOwnProperty.call(exports, name)) {
        Object.defineProperty(exports, name, { enumerable: true, get: getter });
      }
    }
  };
  require.r = (exports) => {
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    Object.defineProperty(exports, "__esModule", { value: true });
  };
  require.o = (value, property) => Object.prototype.hasOwnProperty.call(value, property);
  require.n = (value) => {
    const getter = (() =>
      value !== null && typeof value === "object" && "__esModule" in value
        ? (value as unknown as { default: unknown }).default
        : value) as (() => unknown) & { a?: () => unknown };
    getter.a = getter;
    return getter;
  };
  require.g = globalThis;
  return require;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function resolveCapabilities(value: unknown): ContentCapabilities {
  const direct = record(value);
  const candidate = record(direct?.default) ?? direct;
  if (
    candidate === undefined ||
    typeof candidate.initializeContentRuntime !== "function" ||
    typeof candidate.encryptChat !== "function" ||
    typeof candidate.decryptChat !== "function" ||
    typeof candidate.createPhotoSnap !== "function" ||
    typeof candidate.exportState !== "function" ||
    (candidate.refreshAuth !== undefined && typeof candidate.refreshAuth !== "function")
  ) {
    throw new AppError("UNSUPPORTED_BUILD", "Content runtime module shape does not match build adapter");
  }
  return candidate as unknown as ContentCapabilities;
}

class Build8dd50222Adapter implements BuildAdapter {
  readonly buildId = "8dd50222" as const;
  private capabilities?: ContentCapabilities;

  async initialize(context: BundleContext): Promise<void> {
    const match = findUniqueModule(context.modules, [
      "ContentEnvelope",
      "EnvelopeEncryption",
      "FideliusEncryption",
    ]);
    const require = createWebpackRequire(context.modules);
    const capabilities = resolveCapabilities(require(match.id));
    await capabilities.initializeContentRuntime(context);
    this.capabilities = capabilities;
  }

  private ready(): ContentCapabilities {
    if (this.capabilities === undefined) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Build adapter is not initialized");
    }
    return this.capabilities;
  }

  encryptChat(input: ChatInput): Promise<EncryptedContent> {
    return this.ready().encryptChat(input);
  }

  decryptChat(input: EncryptedContent): Promise<ChatMessage> {
    return this.ready().decryptChat(input);
  }

  createPhotoSnap(input: PhotoSnapInput): Promise<EncryptedContent> {
    return this.ready().createPhotoSnap(input);
  }

  refreshAuth(): Promise<AuthRefreshResult> {
    const refresh = this.ready().refreshAuth;
    if (refresh === undefined) {
      throw new AppError("SESSION_REEXPORT_REQUIRED", "This build adapter cannot refresh authentication");
    }
    return refresh();
  }

  exportState(): Promise<CryptoStateExport> {
    return this.ready().exportState();
  }
}

export function createBuild8dd50222Adapter(): BuildAdapter {
  return new Build8dd50222Adapter();
}

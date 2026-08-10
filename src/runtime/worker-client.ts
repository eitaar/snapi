import { Worker, type TransferListItem } from "node:worker_threads";
import { AppError } from "../errors.js";
import type { SessionExport } from "../session/types.js";
import type {
  AuthRefreshResult,
  ChatInput,
  ChatMessage,
  CryptoStateExport,
  EncryptedContent,
  PhotoSnapInput,
  RuntimeStatus,
} from "./content-types.js";
import type { RuntimeCommand, RuntimeRequest, RuntimeResponse, SerializedAppError } from "./protocol.js";

export interface ContentRuntimeClientOptions {
  readonly workerUrl?: URL;
  readonly timeoutMs?: number;
  readonly assetDir?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppError) => void;
  readonly timer: NodeJS.Timeout;
}

function serializedError(value: unknown): value is SerializedAppError {
  if (value === null || typeof value !== "object") return false;
  const error = value as Partial<SerializedAppError>;
  return typeof error.code === "string" && typeof error.message === "string" &&
    error.details !== null && typeof error.details === "object" && !Array.isArray(error.details);
}

function runtimeResponse(value: unknown): value is RuntimeResponse {
  if (value === null || typeof value !== "object") return false;
  const response = value as { id?: unknown; ok?: unknown; error?: unknown };
  if (!Number.isSafeInteger(response.id) || typeof response.ok !== "boolean") return false;
  return response.ok || serializedError(response.error);
}

export class ContentRuntimeClient {
  private readonly worker: Worker;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(options: ContentRuntimeClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.worker = new Worker(options.workerUrl ?? new URL("./worker-entry.js", import.meta.url), {
      workerData: { assetDir: options.assetDir },
    });
    this.worker.on("message", (value: unknown) => this.handleMessage(value));
    this.worker.once("error", (error) => {
      this.failAll(new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime Worker failed", {
        errorName: error.name,
      }));
    });
    this.worker.once("exit", (code) => {
      if (!this.closed) {
        this.failAll(new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime Worker exited", { exitCode: code }));
      }
    });
  }

  private handleMessage(value: unknown): void {
    if (!runtimeResponse(value) || !this.pending.has(value.id)) {
      this.failAll(new AppError("WORKER_PROTOCOL_ERROR", "Content runtime returned an invalid response"));
      void this.worker.terminate();
      return;
    }
    const pending = this.pending.get(value.id)!;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.ok) {
      pending.resolve(value.value);
    } else {
      pending.reject(new AppError(value.error.code, value.error.message, value.error.details));
    }
  }

  private failAll(error: AppError): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(request: RuntimeCommand, transferList: readonly TransferListItem[] = []): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime request timed out", {
          method: request.method,
          timeoutMs: this.timeoutMs,
        });
        reject(error);
        this.failAll(error);
        void this.worker.terminate();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      const message = { id, ...request } as RuntimeRequest;
      this.worker.postMessage(message, transferList);
    });
  }

  initialize(session: SessionExport): Promise<RuntimeStatus> {
    return this.call({ method: "initialize", session });
  }

  encryptChat(input: ChatInput): Promise<EncryptedContent> {
    return this.call({ method: "encryptChat", input });
  }

  decryptChat(input: EncryptedContent): Promise<ChatMessage> {
    return this.call({ method: "decryptChat", input }, [input.bytes.buffer as ArrayBuffer]);
  }

  createPhotoSnap(input: PhotoSnapInput): Promise<EncryptedContent> {
    return this.call({ method: "createPhotoSnap", input }, [input.contentReference.buffer as ArrayBuffer]);
  }

  refreshAuth(): Promise<AuthRefreshResult> {
    return this.call({ method: "refreshAuth" });
  }

  exportState(): Promise<CryptoStateExport> {
    return this.call({ method: "exportState" });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.call<void>({ method: "shutdown" });
    this.closed = true;
    await this.worker.terminate();
  }
}

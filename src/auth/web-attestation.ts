import { Worker } from "node:worker_threads";
import { AppError } from "../errors.js";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const ATTESTATION_WASM_URL = "https://cf-st.sc-cdn.net/dw/c3e1083e9403dafd38c4.wasm";

export interface WebAttestationOptions {
  readonly assetDir: string;
  readonly timeoutMs?: number;
  readonly workerUrl?: URL;
}

export interface WebAttestationDependencies {
  readonly run?: (accountId: string, options: WebAttestationOptions) => Promise<string>;
}

interface WorkerResultMessage {
  readonly type: "result";
  readonly value?: unknown;
}

interface WorkerErrorMessage {
  readonly type: "error";
  readonly code?: unknown;
  readonly errorName?: unknown;
}

function validAccountId(accountId: string): boolean {
  return ACCOUNT_ID_PATTERN.test(accountId);
}

function usableProof(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function workerErrorCode(value: unknown): "AUTH_CONTEXT_UNAVAILABLE" | "UNSUPPORTED_BUILD" | undefined {
  return value === "AUTH_CONTEXT_UNAVAILABLE" || value === "UNSUPPORTED_BUILD" ? value : undefined;
}

async function runWorker(
  accountId: string,
  options: WebAttestationOptions,
): Promise<string> {
  const worker = new Worker(options.workerUrl ?? new URL("./web-attestation-worker-entry.js", import.meta.url), {
    workerData: {
      accountId,
      assetDir: options.assetDir,
      wasmUrl: ATTESTATION_WASM_URL,
    },
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
      void worker.terminate();
    };
    const timeout = setTimeout(() => finish(() => reject(new AppError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "Standalone Web Attestation timed out",
      { timeoutMs },
    ))), timeoutMs);
    worker.on("message", (message: WorkerResultMessage | WorkerErrorMessage) => {
      if (message.type === "result") {
        const proof = message.value;
        if (!usableProof(proof)) {
          finish(() => reject(new AppError(
            "AUTH_CONTEXT_UNAVAILABLE",
            "Standalone Web Attestation did not return a usable proof",
          )));
          return;
        }
        finish(() => resolve(proof));
        return;
      }
      const code = workerErrorCode(message.code) ?? "AUTH_CONTEXT_UNAVAILABLE";
      finish(() => reject(new AppError(code, "Standalone Web Attestation runtime failed", {
        errorName: typeof message.errorName === "string" ? message.errorName : "UnknownError",
      })));
    });
    worker.once("error", (error) => finish(() => reject(new AppError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "Standalone Web Attestation runtime failed",
      { errorName: error.name },
    ))));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new AppError(
        "AUTH_CONTEXT_UNAVAILABLE",
        "Standalone Web Attestation runtime exited",
        { exitCode: code },
      )));
    });
  });
}

export async function finalizeWebAttestation(
  accountId: string,
  options: WebAttestationOptions,
  dependencies: WebAttestationDependencies = {},
): Promise<string> {
  if (!validAccountId(accountId)) {
    throw new AppError("INVALID_SESSION_EXPORT", "Session account ID is not a UUID");
  }
  if (options.assetDir.trim() === "") {
    throw new AppError("INVALID_CONFIG", "Web Attestation asset directory is required");
  }
  const proof = await (dependencies.run ?? runWorker)(accountId, options);
  if (!usableProof(proof)) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Standalone Web Attestation did not return a usable proof");
  }
  return proof;
}

export const webAttestationWasmUrl = ATTESTATION_WASM_URL;

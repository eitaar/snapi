import { readFile as readFileFromDisk } from "node:fs/promises";
import { loadEnvironmentFile } from "../../config.js";
import { AppError } from "../../errors.js";
import { parseJsonWithBytes } from "../../session/binary-json.js";
import { parseSessionExport } from "../../session/schema.js";
import { runReadOnlyAuthProbe, type ReadOnlyAuthProbeInput } from "../../diagnostics/read-only-auth-probe.js";
import type { CliIo } from "../io.js";

export interface DebugAuthGapDependencies {
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

function invalid(message: string): AppError {
  return new AppError("INVALID_CONFIG", message);
}

function objectAt(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(message);
  return value;
}

function parseRequest(value: unknown): ReadOnlyAuthProbeInput["request"] {
  const request = objectAt(value, "Auth-gap request input is invalid");
  const headersValue = objectAt(request.headers, "Auth-gap request headers are invalid");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headersValue)) {
    headers[name] = stringAt(headerValue, "Auth-gap request header value is invalid");
  }
  return {
    url: stringAt(request.url, "Auth-gap request URL is required"),
    method: stringAt(request.method, "Auth-gap request method is required"),
    headers,
    bodyBase64: stringAt(request.bodyBase64, "Auth-gap request bodyBase64 is required"),
  };
}

async function readJson(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw invalid("Unable to read auth-gap input");
  }
  try {
    return parseJsonWithBytes(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("Auth-gap input is not valid JSON");
  }
}

function parseArgs(argv: readonly string[]): {
  readonly requestPath: string;
  readonly sessionPath: string;
  readonly mode: ReadOnlyAuthProbeInput["mode"];
  readonly authEpoch: string;
} {
  if (argv.length !== 8) throw invalid("Usage: snap debug auth-gap --request <file> --session <file> --mode <mode> --auth-epoch <id>");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw invalid("Invalid auth-gap arguments");
    }
    if (values.has(flag)) throw invalid("Duplicate auth-gap argument");
    values.set(flag, value);
  }
  const requestPath = values.get("--request");
  const sessionPath = values.get("--session");
  const mode = values.get("--mode");
  const authEpoch = values.get("--auth-epoch");
  if (requestPath === undefined || sessionPath === undefined || authEpoch === undefined) {
    throw invalid("Auth-gap request, session, mode, and auth epoch are required");
  }
  if (mode !== "node-bearer" && mode !== "node-web-cookie") {
    throw invalid("Auth-gap mode is not supported");
  }
  return { requestPath, sessionPath, mode, authEpoch: stringAt(authEpoch, "Auth-gap auth epoch is required") };
}

export async function runDebugAuthGap(
  argv: readonly string[],
  io: CliIo,
  dependencies: DebugAuthGapDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? (() => {
    loadEnvironmentFile();
    return process.env;
  })();
  if (env.SNAP_LIVE_TESTS !== "1") {
    throw new AppError("INVALID_CONFIG", "Set SNAP_LIVE_TESTS=1 to run the read-only auth-gap probe");
  }

  const args = parseArgs(argv);
  const readFile = dependencies.readFile ?? (async (path: string) => {
    const bytes = await readFileFromDisk(path);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  });
  const request = parseRequest(await readJson(args.requestPath, readFile));
  const session = parseSessionExport(await readJson(args.sessionPath, readFile));
  const observation = await runReadOnlyAuthProbe({
    authEpoch: args.authEpoch,
    mode: args.mode,
    request,
    auth: {
      httpToken: session.auth.httpToken,
      cookieHeader: session.auth.cookieHeader,
    },
  }, {
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  io.stdout(JSON.stringify({ type: "debug.auth-gap", ...observation }));
  return 0;
}

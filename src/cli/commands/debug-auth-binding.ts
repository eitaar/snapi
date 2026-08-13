import { readFile as readFileFromDisk, realpath as realpathFromDisk } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { classifyAuthBinding } from "../../diagnostics/auth-binding-classifier.js";
import { summarizeAuthBindingHar } from "../../diagnostics/auth-binding-har.js";
import {
  runNodeAuthBindingProbe,
  type NodeAuthBindingProbeDependencies,
  type NodeAuthBindingProbeInput,
} from "../../diagnostics/auth-binding-probe.js";
import {
  type AuthBindingContext,
  type AuthBindingOperation,
  type AuthBindingProtocol,
  type SafeAuthBindingObservation,
} from "../../diagnostics/auth-binding-types.js";
import { AppError } from "../../errors.js";
import { loadSession } from "../../session/loader.js";
import type { CliIo } from "../io.js";

const contexts = new Set<AuthBindingContext>([
  "brave-natural",
  "brave-reload",
  "brave-restart",
  "brave-h2-natural",
  "brave-page-replay",
  "brave-worker-replay",
  "node-http1",
  "node-http2",
  "dotnet-http3",
  "node-gateway",
  "dotnet-gateway",
]);
const operations = new Set<AuthBindingOperation>(["messaging-read", "gateway-handshake"]);
const protocols = new Set<AuthBindingProtocol>(["http/1.1", "h2", "h3", "websocket"]);
const endpointPaths = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/BatchDeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
  "/snapchat.gateway.Gateway/WebSocketConnect",
]);
const transportErrors = new Set<NonNullable<SafeAuthBindingObservation["transportError"]>>([
  "timeout", "connection", "tls", "other",
]);
const observationKeys = new Set([
  "authEpoch",
  "context",
  "operation",
  "endpointPath",
  "startedAt",
  "status",
  "protocol",
  "requestBodyBytes",
  "requestBodySha256",
  "safeHeaderNames",
  "tokenEqualsEpochBaseline",
  "connectionEqualsPrevious",
  "browserProcessEqualsPrevious",
  "networkRouteEqualsBaseline",
  "bootstrapStage",
  "transportError",
]);

export interface DebugAuthBindingDependencies {
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly realpath?: (path: string) => Promise<string>;
  readonly loadSession?: typeof loadSession;
  readonly gatewayProbe?: NodeAuthBindingProbeDependencies["gatewayProbe"];
  readonly http2Connect?: NodeAuthBindingProbeDependencies["http2Connect"];
  readonly runNodeAuthBindingProbe?: typeof runNodeAuthBindingProbe;
}

function invalid(message: string): AppError {
  return new AppError("INVALID_CONFIG", message);
}

function environment(dependencies: DebugAuthBindingDependencies): NodeJS.ProcessEnv {
  if (dependencies.env !== undefined) return dependencies.env;
  loadEnvironmentFile();
  return process.env;
}

function outputFormat(env: NodeJS.ProcessEnv): "human" | "json" {
  const output = env.SNAP_OUTPUT ?? "human";
  if (output !== "human" && output !== "json") throw invalid("SNAP_OUTPUT must be human or json");
  return output;
}

function emit(
  io: CliIo,
  output: "human" | "json",
  type: "debug.auth-binding" | "debug.auth-binding.har",
  value: object,
): void {
  if (output === "json") {
    io.stdout(JSON.stringify({ type, ...value }));
    return;
  }
  io.stdout(type === "debug.auth-binding.har"
    ? "Auth-binding HAR summary completed."
    : "Auth-binding diagnostic completed.");
}

function parseFlags(argv: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  if (argv.length !== allowed.length * 2) throw invalid("Invalid auth-binding arguments");
  const allowedSet = new Set(allowed);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined || value === undefined || !allowedSet.has(flag) || values.has(flag) ||
      value.trim() === "" || value.startsWith("--")
    ) {
      throw invalid("Invalid auth-binding arguments");
    }
    values.set(flag, value);
  }
  return Object.fromEntries(allowed.map((flag) => {
    const value = values.get(flag);
    if (value === undefined) throw invalid("Missing auth-binding argument");
    return [flag, value];
  }));
}

function epoch(value: string): string {
  if (value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw invalid("Auth-binding epoch is invalid");
  }
  return value;
}

async function privatePath(
  config: AppConfig,
  suppliedPath: string,
  dependencies: DebugAuthBindingDependencies,
): Promise<string> {
  const candidate = resolve(suppliedPath);
  const resolveRealpath = dependencies.realpath ?? realpathFromDisk;
  let root: string;
  let resolvedCandidate: string;
  try {
    root = await resolveRealpath(dirname(config.sessionFile));
    resolvedCandidate = await resolveRealpath(candidate);
  } catch {
    throw invalid("Unable to resolve diagnostic input");
  }
  const pathFromRoot = relative(root, resolvedCandidate);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw invalid("Diagnostic input must be inside the configured private directory");
  }
  return resolvedCandidate;
}

async function readBytes(
  path: string,
  dependencies: DebugAuthBindingDependencies,
): Promise<Uint8Array> {
  try {
    if (dependencies.readFile !== undefined) return await dependencies.readFile(path);
    const bytes = await readFileFromDisk(path);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    throw invalid("Unable to read diagnostic input");
  }
}

async function readJson(path: string, dependencies: DebugAuthBindingDependencies): Promise<unknown> {
  const bytes = await readBytes(path, dependencies);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("Diagnostic input is not valid JSON");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("Diagnostic input is invalid");
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength = 128): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength || /[\r\n]/.test(value)) {
    throw invalid("Diagnostic input is invalid");
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid("Diagnostic input is invalid");
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : boolean(value);
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid("Diagnostic input is invalid");
  return value;
}

function exactKeys(record: Readonly<Record<string, unknown>>): void {
  if (Object.keys(record).some((key) => !observationKeys.has(key))) throw invalid("Diagnostic input is invalid");
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw invalid("Diagnostic input is invalid");
  return value as T;
}

function safeHeaderNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^[a-z0-9-]{1,64}$/.test(name))) {
    throw invalid("Diagnostic input is invalid");
  }
  return [...value];
}

function parseObservation(value: unknown): SafeAuthBindingObservation {
  const candidate = object(value);
  exactKeys(candidate);
  const authEpoch = text(candidate.authEpoch, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(authEpoch)) throw invalid("Diagnostic input is invalid");
  const endpointPath = text(candidate.endpointPath, 256);
  if (!endpointPaths.has(endpointPath)) throw invalid("Diagnostic input is invalid");
  const startedAt = text(candidate.startedAt, 32);
  if (Number.isNaN(Date.parse(startedAt))) throw invalid("Diagnostic input is invalid");
  const status = optionalInteger(candidate.status);
  if (status !== undefined && (status < 100 || status > 599)) throw invalid("Diagnostic input is invalid");
  const requestBodyBytes = optionalInteger(candidate.requestBodyBytes);
  const requestBodySha256 = candidate.requestBodySha256 === undefined
    ? undefined
    : text(candidate.requestBodySha256, 64);
  if (requestBodySha256 !== undefined && !/^[a-f0-9]{64}$/i.test(requestBodySha256)) {
    throw invalid("Diagnostic input is invalid");
  }
  const bootstrapStage = candidate.bootstrapStage === undefined ? undefined : text(candidate.bootstrapStage, 64);
  if (bootstrapStage !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bootstrapStage)) {
    throw invalid("Diagnostic input is invalid");
  }
  return {
    authEpoch,
    context: enumValue(candidate.context, contexts),
    operation: enumValue(candidate.operation, operations),
    endpointPath,
    startedAt,
    ...(status === undefined ? {} : { status }),
    ...(candidate.protocol === undefined ? {} : { protocol: enumValue(candidate.protocol, protocols) }),
    ...(requestBodyBytes === undefined ? {} : { requestBodyBytes }),
    ...(requestBodySha256 === undefined ? {} : { requestBodySha256 }),
    safeHeaderNames: safeHeaderNames(candidate.safeHeaderNames),
    tokenEqualsEpochBaseline: boolean(candidate.tokenEqualsEpochBaseline),
    ...(optionalBoolean(candidate.connectionEqualsPrevious) === undefined
      ? {} : { connectionEqualsPrevious: optionalBoolean(candidate.connectionEqualsPrevious)! }),
    ...(optionalBoolean(candidate.browserProcessEqualsPrevious) === undefined
      ? {} : { browserProcessEqualsPrevious: optionalBoolean(candidate.browserProcessEqualsPrevious)! }),
    ...(optionalBoolean(candidate.networkRouteEqualsBaseline) === undefined
      ? {} : { networkRouteEqualsBaseline: optionalBoolean(candidate.networkRouteEqualsBaseline)! }),
    ...(bootstrapStage === undefined ? {} : { bootstrapStage }),
    ...(candidate.transportError === undefined
      ? {} : { transportError: enumValue(candidate.transportError, transportErrors) }),
  };
}

function parseObservations(value: unknown): readonly SafeAuthBindingObservation[] {
  if (!Array.isArray(value)) throw invalid("Diagnostic input is invalid");
  return value.map(parseObservation);
}

function parseRequest(value: unknown): NonNullable<NodeAuthBindingProbeInput["request"]> {
  const candidate = object(value);
  if (Object.keys(candidate).some((key) => !["url", "method", "headers", "bodyBase64"].includes(key))) {
    throw invalid("Diagnostic input is invalid");
  }
  const headersValue = object(candidate.headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(headersValue)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw invalid("Diagnostic input is invalid");
    headers[name] = text(value, 4096);
  }
  return {
    url: text(candidate.url, 512),
    method: text(candidate.method, 16),
    headers,
    bodyBase64: text(candidate.bodyBase64, 4_000_000),
  };
}

async function configuredSession(
  config: AppConfig,
  dependencies: DebugAuthBindingDependencies,
): Promise<Awaited<ReturnType<typeof loadSession>>> {
  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await (dependencies.loadSession ?? loadSession)(config.sessionFile);
  } catch {
    throw invalid("Unable to load configured session");
  }
  if (session.accountId !== config.accountId || session.buildId !== config.buildId) {
    throw invalid("Configured session does not match the configured account or build");
  }
  return session;
}

function configFor(env: NodeJS.ProcessEnv): AppConfig {
  try {
    return loadConfig(env);
  } catch {
    throw invalid("Diagnostic configuration is invalid");
  }
}

async function runHar(
  argv: readonly string[],
  io: CliIo,
  dependencies: DebugAuthBindingDependencies,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const args = parseFlags(argv, ["--file", "--epoch"]);
  epoch(args["--epoch"]!);
  const config = configFor(env);
  const file = await privatePath(config, args["--file"]!, dependencies);
  const summary = summarizeAuthBindingHar(await readBytes(file, dependencies));
  emit(io, outputFormat(env), "debug.auth-binding.har", summary);
  return 0;
}

async function runProbe(
  argv: readonly string[],
  io: CliIo,
  dependencies: DebugAuthBindingDependencies,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const args = parseFlags(argv, ["--request", "--mode", "--epoch"]);
  if (args["--mode"] !== "node-http1" && args["--mode"] !== "node-http2") throw invalid("Auth-binding probe mode is invalid");
  const authEpoch = epoch(args["--epoch"]!);
  const config = configFor(env);
  const requestPath = await privatePath(config, args["--request"]!, dependencies);
  const session = await configuredSession(config, dependencies);
  const request = parseRequest(await readJson(requestPath, dependencies));
  const observation = await (dependencies.runNodeAuthBindingProbe ?? runNodeAuthBindingProbe)({
    authEpoch,
    context: args["--mode"],
    request,
    auth: {
      httpToken: session.auth.httpToken,
      cookieHeader: session.auth.cookieHeader,
    },
  }, {
    ...(dependencies.http2Connect === undefined ? {} : { http2Connect: dependencies.http2Connect }),
    ...(dependencies.gatewayProbe === undefined ? {} : { gatewayProbe: dependencies.gatewayProbe }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  emit(io, outputFormat(env), "debug.auth-binding", observation);
  return 0;
}

async function runGateway(
  argv: readonly string[],
  io: CliIo,
  dependencies: DebugAuthBindingDependencies,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const args = parseFlags(argv, ["--mode", "--epoch"]);
  if (args["--mode"] !== "node-gateway") throw invalid("Auth-binding gateway mode is invalid");
  const authEpoch = epoch(args["--epoch"]!);
  const config = configFor(env);
  const session = await configuredSession(config, dependencies);
  const observation = await (dependencies.runNodeAuthBindingProbe ?? runNodeAuthBindingProbe)({
    authEpoch,
    context: "node-gateway",
    auth: {
      httpToken: session.auth.httpToken,
      cookieHeader: session.auth.cookieHeader,
      gatewayToken: session.auth.gatewayToken,
    },
  }, {
    ...(dependencies.http2Connect === undefined ? {} : { http2Connect: dependencies.http2Connect }),
    ...(dependencies.gatewayProbe === undefined ? {} : { gatewayProbe: dependencies.gatewayProbe }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  emit(io, outputFormat(env), "debug.auth-binding", observation);
  return 0;
}

async function runClassify(
  argv: readonly string[],
  io: CliIo,
  dependencies: DebugAuthBindingDependencies,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const args = parseFlags(argv, ["--observations"]);
  const conclusion = classifyAuthBinding(parseObservations(await readJson(args["--observations"]!, dependencies)));
  emit(io, outputFormat(env), "debug.auth-binding", { conclusion });
  return 0;
}

export async function runDebugAuthBinding(
  argv: readonly string[],
  io: CliIo,
  dependencies: DebugAuthBindingDependencies = {},
): Promise<number> {
  const command = argv[0];
  if ((command === "probe" || command === "gateway") &&
    (dependencies.env ?? process.env).SNAP_LIVE_TESTS !== "1") {
    throw invalid("Set SNAP_LIVE_TESTS=1 to run the read-only auth-binding probe");
  }
  const env = environment(dependencies);
  if (command === "har") return runHar(argv.slice(1), io, dependencies, env);
  if (command === "probe") return runProbe(argv.slice(1), io, dependencies, env);
  if (command === "gateway") return runGateway(argv.slice(1), io, dependencies, env);
  if (command === "classify") return runClassify(argv.slice(1), io, dependencies, env);
  throw invalid("Auth-binding command is invalid");
}

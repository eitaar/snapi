import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { AppError } from "../errors.js";
import { CookieJar } from "./cookie-jar.js";

const DBSC_SITE_KEY = "https://snapchat.com";
const DEFAULT_REFRESH_URL = "https://accounts.snapchat.com/accounts/dbsc/refresh";
const BRAVE_PROFILE_ENV = "SNAP_BRAVE_PROFILE_DIR";
const POWERSHELL_ENV = "SNAP_POWERSHELL";

export interface StoredDbscSession {
  readonly sessionId: string;
  readonly refreshUrl: string;
  readonly wrappedKey: Uint8Array;
}

export type DbscAlgorithm = "RS256" | "ES256";

export interface DbscSigner {
  readonly algorithm: DbscAlgorithm;
  readonly sign: (input: Uint8Array) => Promise<Uint8Array>;
}

export interface DbscRefreshResult {
  readonly cookieHeader: string;
}

export interface DbscRefreshDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly profileDir?: string;
  readonly openSession?: () => Promise<StoredDbscSession>;
  readonly createSigner?: (wrappedKey: Uint8Array) => Promise<DbscSigner>;
}

interface WireField {
  readonly number: number;
  readonly wireType: number;
  readonly bytes?: Uint8Array;
}

function readVarint(buffer: Uint8Array, offset: number): { readonly value: number; readonly offset: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length && shift <= 63n) {
    const byte = buffer[cursor]!;
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: Number(value), offset: cursor };
    shift += 7n;
  }
  throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC protobuf is malformed");
}

function readFields(buffer: Uint8Array): readonly WireField[] {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const wireType = tag.value & 7;
    const number = tag.value >>> 3;
    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > buffer.length) throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC protobuf is truncated");
      fields.push({ number, wireType, bytes: buffer.slice(offset, end) });
      offset = end;
      continue;
    }
    if (wireType === 0) {
      offset = readVarint(buffer, offset).offset;
      fields.push({ number, wireType });
      continue;
    }
    if (wireType === 1) {
      offset += 8;
      if (offset > buffer.length) throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC protobuf is truncated");
      fields.push({ number, wireType });
      continue;
    }
    if (wireType === 5) {
      offset += 4;
      if (offset > buffer.length) throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC protobuf is truncated");
      fields.push({ number, wireType });
      continue;
    }
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC protobuf uses an unsupported wire type");
  }
  return fields;
}

function bytesField(fields: readonly WireField[], number: number): Uint8Array | undefined {
  return fields.find((field) => field.number === number && field.wireType === 2)?.bytes;
}

function requiredBytesField(fields: readonly WireField[], number: number): Uint8Array {
  const value = bytesField(fields, number);
  if (value === undefined) throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC session is incomplete");
  return value;
}

function utf8(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC session is incomplete");
  const value = new TextDecoder().decode(bytes);
  if (value.trim() === "" || value.includes("\uFFFD")) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC session contains invalid text");
  }
  return value;
}

export function parseDbscSessionProto(proto: Uint8Array): StoredDbscSession {
  const outer = requiredBytesField(readFields(proto), 1);
  const record = readFields(outer);
  const sessionId = utf8(bytesField(record, 1));
  const state = readFields(requiredBytesField(record, 2));
  const refreshUrl = utf8(bytesField(state, 2));
  if (refreshUrl !== DEFAULT_REFRESH_URL) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC session uses an unsupported refresh endpoint");
  }
  const wrappedKey = bytesField(state, 5);
  if (wrappedKey === undefined || wrappedKey.byteLength === 0) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Chromium DBSC session has no wrapped key");
  }
  return {
    sessionId,
    refreshUrl: refreshUrl || DEFAULT_REFRESH_URL,
    wrappedKey: wrappedKey.slice(),
  };
}

export function parseDbscChallenge(value: string): string {
  const match = /^"([^"\\]*)";id="[^"\\]*"$/.exec(value.trim());
  if (match?.[1] === undefined || match[1] === "") {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Snapchat returned an unsupported DBSC challenge");
  }
  return match[1];
}

export function resolveOptionalBraveProfileDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env[BRAVE_PROFILE_ENV]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") return undefined;
  return join(localAppData, "BraveSoftware", "Brave-Browser", "User Data", "Default");
}

export function resolveBraveProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const profileDir = resolveOptionalBraveProfileDir(env);
  if (profileDir !== undefined) return profileDir;
  throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave DBSC profile directory is unavailable");
}

export async function openBraveDbscSession(profileDir = resolveBraveProfileDir()): Promise<StoredDbscSession> {
  const path = join(profileDir, "Network", "Device Bound Sessions");
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare("SELECT proto FROM dbsc_session_tbl WHERE key = ?").get(DBSC_SITE_KEY) as
        | { readonly proto?: Uint8Array }
        | undefined;
      if (row?.proto === undefined) {
        throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave has no Snapchat DBSC session");
      }
      return parseDbscSessionProto(new Uint8Array(row.proto));
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to read Brave's DBSC session store", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function proofJwt(challenge: string, signer: DbscSigner): { readonly input: Uint8Array; readonly header: string; readonly payload: string } {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ typ: "dbsc+jwt", alg: signer.algorithm })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ jti: challenge })));
  const signingInput = `${header}.${payload}`;
  return { input: new TextEncoder().encode(signingInput), header, payload };
}

export async function refreshBraveDbsc(
  cookieHeader: string,
  dependencies: DbscRefreshDependencies = {},
): Promise<DbscRefreshResult> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const openSession = dependencies.openSession ?? (() => openBraveDbscSession(dependencies.profileDir));
  let session: StoredDbscSession;
  try {
    session = await openSession();
  } catch (error) {
    throw error instanceof AppError ? error : new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave DBSC session is unavailable");
  }

  const requestHeaders = {
    origin: "https://web.snapchat.com",
    referer: "https://web.snapchat.com/",
    cookie: cookieHeader,
    "sec-secure-session-id": JSON.stringify(session.sessionId),
  };
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch(session.refreshUrl, { method: "POST", redirect: "manual", headers: requestHeaders });
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to contact Snapchat's DBSC refresh endpoint", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  const challengeHeader = challengeResponse.headers.get("secure-session-challenge");
  if (challengeHeader === null) {
    if (!challengeResponse.ok) {
      throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Snapchat rejected the DBSC refresh", { status: challengeResponse.status });
    }
      return {
        cookieHeader: new CookieJar()
          .mergeHeader(session.refreshUrl, cookieHeader)
          .setFromResponse(session.refreshUrl, challengeResponse)
          .headerFor(session.refreshUrl),
      };
  }

  const challenge = parseDbscChallenge(challengeHeader);
  const createSigner = dependencies.createSigner ?? ((wrappedKey: Uint8Array) => createWindowsCngSigner(wrappedKey));
  const signer = await createSigner(session.wrappedKey);
  const proof = proofJwt(challenge, signer);
  const signature = await signer.sign(proof.input);
  if (signature.byteLength === 0) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "DBSC signer returned an empty signature");
  }
  const response = `${proof.header}.${proof.payload}.${base64Url(signature)}`;
  let refreshed: Response;
  try {
    refreshed = await fetch(session.refreshUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...requestHeaders,
        "secure-session-response": JSON.stringify(response),
      },
    });
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Unable to submit the DBSC proof", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (!refreshed.ok) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Snapchat rejected the DBSC proof", { status: refreshed.status });
  }
  return {
    cookieHeader: new CookieJar()
      .mergeHeader(session.refreshUrl, cookieHeader)
      .setFromResponse(session.refreshUrl, refreshed)
      .headerFor(session.refreshUrl),
  };
}

interface PowerShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function runPowerShell(script: string, input: string): Promise<PowerShellResult> {
  const command = Buffer.from(script, "utf16le").toString("base64");
  const executable = process.env[POWERSHELL_ENV]?.trim() || "powershell.exe";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.stdin.end(input);
  });
}

const CNG_SCRIPT = String.raw`
$lines = [regex]::Split([Console]::In.ReadToEnd(), '\r?\n')
$mode = $lines[0]
$wrapped = [Convert]::FromBase64String($lines[1])
$payloadInput = if ($lines.Length -gt 2 -and $lines[2] -ne '') { [Convert]::FromBase64String($lines[2]) } else { [byte[]]@() }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
[StructLayout(LayoutKind.Sequential)] public struct DbscPkcs1Info { public IntPtr pszAlgId; }
public static class DbscCngNative {
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] public static extern int NCryptOpenStorageProvider(out IntPtr p, string n, uint f);
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] public static extern int NCryptImportKey(IntPtr p, IntPtr k, string t, IntPtr q, out IntPtr h, byte[] d, int n, uint f);
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] public static extern int NCryptGetProperty(IntPtr h, string n, byte[] d, int l, out int r, uint f);
  [DllImport("ncrypt.dll")] public static extern int NCryptSignHash(IntPtr h, IntPtr pad, byte[] d, int dl, byte[] s, int sl, out int r, uint f);
  [DllImport("ncrypt.dll")] public static extern int NCryptFreeObject(IntPtr h);
  public static string Algorithm(IntPtr h, out int status) { var b=new byte[64]; int n; status=NCryptGetProperty(h,"Algorithm Name",b,b.Length,out n,0); return status==0 ? System.Text.Encoding.Unicode.GetString(b,0,n).TrimEnd('\0') : ""; }
  public static byte[] Sign(IntPtr h, string algorithm, byte[] input, out int status) { byte[] digest; using(var sha=SHA256.Create()){digest=sha.ComputeHash(input);} var output=new byte[Math.Max(64, algorithm=="RSA" ? 256 : 64)]; IntPtr info=IntPtr.Zero; IntPtr alg=IntPtr.Zero; uint flags=0x40; try { if(algorithm=="RSA"){ alg=Marshal.StringToHGlobalUni("SHA256"); var p=new DbscPkcs1Info{pszAlgId=alg}; info=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(DbscPkcs1Info))); Marshal.StructureToPtr(p,info,false); flags|=2; } int n; status=NCryptSignHash(h,info,digest,digest.Length,output,output.Length,out n,flags); if(status!=0) return new byte[0]; Array.Resize(ref output,n); return output; } finally { if(info!=IntPtr.Zero)Marshal.FreeHGlobal(info); if(alg!=IntPtr.Zero)Marshal.FreeHGlobal(alg); } }
}
'@
$provider = [IntPtr]::Zero
$key = [IntPtr]::Zero
$import = -1
foreach ($providerName in @('Microsoft Platform Crypto Provider','Microsoft Software Key Storage Provider')) {
  $provider = [IntPtr]::Zero
  $open = [DbscCngNative]::NCryptOpenStorageProvider([ref]$provider, $providerName, 0)
  if ($open -ne 0) { continue }
  $key = [IntPtr]::Zero
  $import = [DbscCngNative]::NCryptImportKey($provider, [IntPtr]::Zero, 'OpaqueKeyBlob', [IntPtr]::Zero, [ref]$key, $wrapped, $wrapped.Length, 0)
  if ($import -eq 0) { break }
  [void][DbscCngNative]::NCryptFreeObject($provider)
  $provider = [IntPtr]::Zero
}
if ($import -ne 0) { exit 20 }
$propertyStatus = 0
$algorithm = [DbscCngNative]::Algorithm($key, [ref]$propertyStatus)
if ($propertyStatus -ne 0) { exit 21 }
if ($mode -eq 'inspect') { [Console]::WriteLine($algorithm); exit 0 }
$signStatus = 0
$signature = [DbscCngNative]::Sign($key, $algorithm, $payloadInput, [ref]$signStatus)
if ($signStatus -ne 0 -or $signature.Length -eq 0) { exit 22 }
[Console]::WriteLine($algorithm)
[Console]::WriteLine([Convert]::ToBase64String($signature))
if ($key -ne [IntPtr]::Zero) { [void][DbscCngNative]::NCryptFreeObject($key) }
if ($provider -ne [IntPtr]::Zero) { [void][DbscCngNative]::NCryptFreeObject($provider) }
`;

async function cngCommand(mode: "inspect" | "sign", wrappedKey: Uint8Array, input?: Uint8Array): Promise<readonly string[]> {
  let result: PowerShellResult;
  try {
    result = await runPowerShell(CNG_SCRIPT, [mode, Buffer.from(wrappedKey).toString("base64"), input === undefined ? "" : Buffer.from(input).toString("base64")].join("\r\n"));
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows PowerShell is unavailable for DBSC signing", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (result.code !== 0) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows CNG could not use the Brave DBSC key", { exitCode: result.code });
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

async function createWindowsCngSigner(wrappedKey: Uint8Array): Promise<DbscSigner> {
  if (process.platform !== "win32") {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave DBSC signing requires Windows CNG");
  }
  const inspection = await cngCommand("inspect", wrappedKey);
  const algorithmName = inspection[0];
  const algorithm: DbscAlgorithm = algorithmName === "RSA" ? "RS256" : algorithmName === "ECDSA" ? "ES256" : (() => {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Brave DBSC key uses an unsupported algorithm");
  })();
  return {
    algorithm,
    sign: async (input) => {
      const lines = await cngCommand("sign", wrappedKey, input);
      if (lines[0] !== algorithmName || lines[1] === undefined) {
        throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows CNG returned an invalid DBSC signature");
      }
      return Uint8Array.from(Buffer.from(lines[1], "base64"));
    },
  };
}

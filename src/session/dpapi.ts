import { spawn } from "node:child_process";
import { AppError } from "../errors.js";

export interface SessionProtector {
  readonly protect: (plain: Uint8Array) => Promise<Uint8Array>;
  readonly unprotect: (sealed: Uint8Array) => Promise<Uint8Array>;
}

interface PowerShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function runPowerShell(script: string, input: string): Promise<PowerShellResult> {
  const command = Buffer.from(script, "utf16le").toString("base64");
  const executable = process.env.SNAP_POWERSHELL?.trim() || "powershell.exe";
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

const DPAPI_SCRIPT = String.raw`
$lines = [regex]::Split([Console]::In.ReadToEnd(), '\r?\n')
$mode = $lines[0]
$payload = [Convert]::FromBase64String($lines[1])
Add-Type -AssemblyName System.Security
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($mode -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($payload, $null, $scope)
} elseif ($mode -eq 'unprotect') {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($payload, $null, $scope)
} else {
  throw 'unsupported mode'
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

async function dpapi(mode: "protect" | "unprotect", payload: Uint8Array): Promise<Uint8Array> {
  if (process.platform !== "win32") {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Sealed session storage requires Windows DPAPI");
  }
  let result: PowerShellResult;
  try {
    result = await runPowerShell(DPAPI_SCRIPT, `${mode}\n${Buffer.from(payload).toString("base64")}\n`);
  } catch (error) {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows PowerShell is unavailable for sealed session storage", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  const output = result.stdout.trim();
  if (result.code !== 0 || output === "") {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows DPAPI could not access the sealed session");
  }
  try {
    return Uint8Array.from(Buffer.from(output, "base64"));
  } catch {
    throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "Windows DPAPI returned invalid sealed session data");
  }
}

export function createDpapiProtector(): SessionProtector {
  return {
    protect: (plain) => dpapi("protect", plain),
    unprotect: (sealed) => dpapi("unprotect", sealed),
  };
}

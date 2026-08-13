import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AppError } from "../errors.js";
import type { LoginPrompt } from "../auth/login-state.js";

async function readLine(label: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return await reader.question(label);
  } finally {
    reader.close();
  }
}

async function readSecret(label: string): Promise<Uint8Array> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return new Uint8Array(Buffer.from(await readLine(label), "utf8"));
  }

  stdout.write(label);
  const chunks: number[] = [];
  const previousEncoding = stdin.readableEncoding;
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  return new Promise<Uint8Array>((resolve, reject) => {
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new AppError("INVALID_CONFIG", "Login was cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(Uint8Array.from(chunks));
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          if (chunks.length > 0) {
            chunks.pop();
            stdout.write("\b \b");
          }
          continue;
        }
        const bytes = Buffer.from(character, "utf8");
        chunks.push(...bytes);
        stdout.write("*");
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      (stdin as unknown as { setEncoding: (encoding?: BufferEncoding | null) => void })
        .setEncoding(previousEncoding);
    };
    stdin.on("data", onData);
  });
}

export function createTerminalLoginPrompt(): LoginPrompt {
  return {
    readUsername: () => readLine("Snapchat username: "),
    readPassword: () => readSecret("Password: "),
    readOtp: () => readSecret("One-time code: "),
  };
}

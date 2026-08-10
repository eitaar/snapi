#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createProcessIo, type CliIo } from "./io.js";

export interface CliDependencies {
  readonly runRuntimeDoctor?: (io: CliIo) => Promise<number>;
}

export async function main(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(io.version);
    return 0;
  }
  if (argv.length === 3 && argv[0] === "debug" && argv[1] === "doctor" && argv[2] === "--runtime") {
    const runRuntimeDoctor = dependencies.runRuntimeDoctor ??
      (await import("./commands/debug-doctor.js")).runRuntimeDoctor;
    return runRuntimeDoctor(io);
  }

  io.stderr("Usage: snap <session|chat|snap|gateway|debug>");
  return 2;
}

function packageVersion(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require("../../package.json") as { readonly version: string };
  return packageJson.version;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2), createProcessIo(packageVersion()));
}

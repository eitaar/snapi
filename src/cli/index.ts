#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createProcessIo, type CliIo } from "./io.js";

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(io.version);
    return 0;
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

import { parseArgs } from "node:util";
import { AccountProfileStore } from "../../accounts/profile-store.js";
import type { AccountProfileSummary } from "../../accounts/types.js";
import { isSupportedBuildId, type BuildId } from "../../builds.js";
import { loadSession } from "../../session/loader.js";
import type { CliIo } from "../io.js";

export interface AccountListEntry extends AccountProfileSummary {
  readonly buildId?: BuildId;
}

export interface AccountListDependencies {
  readonly accountsDir?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly output?: "human" | "json";
  readonly list?: () => Promise<readonly AccountListEntry[]>;
  readonly store?: Pick<AccountProfileStore, "list" | "read">;
  readonly loadSession?: typeof loadSession;
}

function usage(io: CliIo): number {
  io.stderr("Usage: snaapi account list [--json]");
  return 2;
}

function resolveOutput(json: boolean, fallback: "human" | "json" = "human"): "human" | "json" {
  return json ? "json" : fallback;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function listDefault(dependencies: AccountListDependencies): Promise<readonly AccountListEntry[]> {
  const cwd = dependencies.cwd ?? process.cwd();
  const accountsDir = dependencies.accountsDir
    ?? dependencies.env?.SNAAPI_ACCOUNTS_DIR
    ?? `${cwd}/private/accounts`;
  const store = dependencies.store ?? new AccountProfileStore(accountsDir);
  const loadProfileSession = dependencies.loadSession ?? loadSession;
  const summaries = await store.list();
  const accounts: AccountListEntry[] = [];
  for (const summary of summaries) {
    if (summary.status !== "ready") {
      accounts.push({ alias: summary.alias, status: summary.status });
      continue;
    }
    try {
      const profile = await store.read(summary.alias);
      const session = await loadProfileSession(profile.sessionFile);
      if (!isSupportedBuildId(session.buildId)) {
        accounts.push({ alias: summary.alias, status: "invalid" });
      } else {
        accounts.push({ alias: summary.alias, buildId: session.buildId, status: "ready" });
      }
    } catch (error) {
      accounts.push({
        alias: summary.alias,
        status: isMissingFile(error) ? "missing-session" : "invalid",
      });
    }
  }
  return accounts;
}

export async function runAccountList(
  argv: readonly string[],
  io: CliIo,
  dependencies: AccountListDependencies = {},
): Promise<number> {
  let json = false;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: { json: { type: "boolean", default: false } },
    });
    json = parsed.values.json;
  } catch {
    return usage(io);
  }

  const output = resolveOutput(json, dependencies.output);
  const accounts = await (dependencies.list ?? (() => listDefault(dependencies)))();
  if (output === "json") {
    io.stdout(JSON.stringify({ type: "accounts.list", accounts }));
    return 0;
  }
  if (accounts.length === 0) {
    io.stdout("No account profiles found.");
    return 0;
  }
  for (const account of accounts) {
    if (account.buildId === undefined) io.stdout(`${account.alias}: ${account.status}`);
    else io.stdout(`${account.alias}: ${account.buildId} (${account.status})`);
  }
  return 0;
}

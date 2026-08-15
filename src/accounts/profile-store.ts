import { link, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { AccountProfileRecord, AccountProfileSummary, AccountProfileV1 } from "./types.js";

const ACCOUNT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertAccountAlias(alias: string): string {
  if (!ACCOUNT_ALIAS.test(alias)) {
    throw new AppError("INVALID_CONFIG", "Account alias is invalid", { alias });
  }
  return alias;
}

type ProfilePaths = Pick<AccountProfileRecord, "sessionFile" | "assetDir">;
type InstallExclusive = (temporaryPath: string, profilePath: string) => Promise<void>;

function invalidProfile(message: string, details: Readonly<Record<string, unknown>> = {}): AppError {
  return new AppError("INVALID_CONFIG", message, details);
}

function toStoredPath(path: string, profileDirectory: string): string {
  const relativePath = relative(profileDirectory, resolve(path));
  return relativePath.split(sep).join("/");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class AccountProfileStore {
  readonly #accountsRoot: string;
  readonly #installExclusive: InstallExclusive;

  constructor(accountsRoot: string, options: { readonly installExclusive?: InstallExclusive } = {}) {
    this.#accountsRoot = resolve(accountsRoot);
    this.#installExclusive = options.installExclusive ?? (async (temporaryPath, profilePath) => {
      await link(temporaryPath, profilePath);
    });
  }

  pathFor(alias: string): string {
    return join(this.#accountsRoot, `${assertAccountAlias(alias)}.json`);
  }

  async add(alias: string, paths: ProfilePaths): Promise<AccountProfileRecord> {
    const validAlias = assertAccountAlias(alias);
    const profilePath = this.pathFor(validAlias);
    const profileDirectory = dirname(profilePath);
    await mkdir(profileDirectory, { recursive: true });
    const sessionFile = resolve(profileDirectory, paths.sessionFile);
    const assetDir = resolve(profileDirectory, paths.assetDir);

    const profile: AccountProfileV1 = {
      formatVersion: 1,
      sessionFile: toStoredPath(sessionFile, profileDirectory),
      assetDir: toStoredPath(assetDir, profileDirectory),
    };
    const temporaryPath = join(profileDirectory, `.${validAlias}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(profile, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#installExclusive(temporaryPath, profilePath);
      await unlink(temporaryPath);
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw invalidProfile("Account alias already exists", { alias: validAlias });
      }
      throw invalidProfile("Unable to write account profile", { alias: validAlias });
    }
    return { alias: validAlias, sessionFile, assetDir };
  }

  async read(alias: string): Promise<AccountProfileRecord> {
    const validAlias = assertAccountAlias(alias);
    const profilePath = this.pathFor(validAlias);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(profilePath, "utf8")) as unknown;
    } catch (error) {
      throw invalidProfile("Account profile is missing or malformed", { alias: validAlias });
    }
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      (parsed as Partial<AccountProfileV1>).formatVersion !== 1 ||
      typeof (parsed as Partial<AccountProfileV1>).sessionFile !== "string" ||
      typeof (parsed as Partial<AccountProfileV1>).assetDir !== "string"
    ) {
      throw invalidProfile("Account profile has an unsupported or incomplete schema", { alias: validAlias });
    }
    const profile = parsed as AccountProfileV1;
    if (isAbsolute(profile.sessionFile) || isAbsolute(profile.assetDir)) {
      throw invalidProfile("Account profile paths must be relative", { alias: validAlias });
    }
    const profileDirectory = dirname(profilePath);
    return {
      alias: validAlias,
      sessionFile: resolve(profileDirectory, profile.sessionFile),
      assetDir: resolve(profileDirectory, profile.assetDir),
    };
  }

  async list(): Promise<AccountProfileSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.#accountsRoot);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const aliases = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter((alias) => ACCOUNT_ALIAS.test(alias))
      .sort();
    const summaries: AccountProfileSummary[] = [];
    for (const alias of aliases) {
      try {
        const profile = await this.read(alias);
        try {
          await stat(profile.sessionFile);
          summaries.push({ alias, status: "ready" });
        } catch (error) {
          summaries.push({ alias, status: isMissingFile(error) ? "missing-session" : "invalid" });
        }
      } catch {
        summaries.push({ alias, status: "invalid" });
      }
    }
    return summaries;
  }
}

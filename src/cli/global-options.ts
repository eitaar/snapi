import { assertAccountAlias } from "../accounts/profile-store.js";
import { AppError } from "../errors.js";

export interface GlobalCliOptions {
  readonly accountAlias?: string;
  readonly argv: readonly string[];
}

export function parseGlobalCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): GlobalCliOptions {
  if (argv[0] === "--account") {
    const alias = argv[1];
    if (alias === undefined) {
      throw new AppError("INVALID_CONFIG", "--account requires an alias");
    }
    return {
      accountAlias: assertAccountAlias(alias),
      argv: argv.slice(2),
    };
  }

  const alias = env.SNAAPI_ACCOUNT?.trim();
  if (alias === undefined || alias === "") {
    return { argv };
  }

  return {
    accountAlias: assertAccountAlias(alias),
    argv,
  };
}

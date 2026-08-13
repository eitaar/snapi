import { AppError } from "../errors.js";
import type { LoginTransport } from "./login-state.js";

export const PINNED_LOGIN_BUILD = "8dd50222" as const;

export interface VerifiedLoginContract {
  readonly buildId: typeof PINNED_LOGIN_BUILD;
  readonly transport: LoginTransport;
}

export function requireVerifiedLoginContract(
  contract: VerifiedLoginContract | undefined,
): LoginTransport {
  if (contract?.buildId !== PINNED_LOGIN_BUILD) {
    throw new AppError(
      "UNSUPPORTED_BUILD",
      "The pinned WebLogin contract is not available; refusing to guess login protobuf fields",
      { buildId: PINNED_LOGIN_BUILD },
    );
  }
  return contract.transport;
}

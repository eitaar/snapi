import { requireVerifiedLoginContract, type VerifiedLoginContract } from "./login-wire.js";
import type { LoginTransport } from "./login-state.js";

export interface LoginClientDependencies {
  readonly verifiedContract?: VerifiedLoginContract;
}

export function createLoginTransport(
  dependencies: LoginClientDependencies = {},
): LoginTransport {
  return requireVerifiedLoginContract(dependencies.verifiedContract);
}

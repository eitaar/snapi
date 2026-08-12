import { AppError } from "../errors.js";
import type { SessionExport } from "../session/types.js";
import type {
  AuthRefreshReason,
  RequestAuth,
  RequestAuthSource,
} from "../transport/auth-provider.js";
import type { RuntimeAuthUpdate } from "./protocol.js";

function requestHeaders(
  previous: Readonly<Record<string, string>>,
  mcsCofSequenceIds: string,
): Readonly<Record<string, string>> {
  const next = { ...previous };
  if (mcsCofSequenceIds === "") delete next["mcs-cof-ids-bin"];
  else next["mcs-cof-ids-bin"] = mcsCofSequenceIds;
  return next;
}

export class RuntimeRequestAuth implements RequestAuthSource {
  private readonly accountId: string;
  private current: RequestAuth;

  constructor(session: SessionExport) {
    this.accountId = session.accountId;
    this.current = {
      httpToken: session.auth.httpToken,
      cookieHeader: session.auth.cookieHeader,
      headers: session.auth.requestHeaders,
    };
  }

  async getRequestAuth(): Promise<RequestAuth> {
    return this.current;
  }

  async refreshOnce(_reason: AuthRefreshReason): Promise<RequestAuth> {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Photo upload authentication expired inside the content runtime",
    );
  }

  update(auth: RuntimeAuthUpdate): void {
    if (auth.accountId !== this.accountId) {
      throw new AppError("WORKER_PROTOCOL_ERROR", "Runtime auth update account does not match");
    }
    this.current = {
      httpToken: auth.httpToken,
      cookieHeader: auth.cookieHeader,
      headers: requestHeaders(this.current.headers, auth.mcsCofSequenceIds),
    };
  }
}

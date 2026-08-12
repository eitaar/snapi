import { dirname, join } from "node:path";
import { applyCookieOverrides } from "../auth/cookie-overrides.js";
import { finalizeWebAttestation } from "../auth/web-attestation.js";
import { loadConfig, loadEnvironmentFile } from "../config.js";
import { GatewayClient } from "../gateway/client.js";
import type { GatewayStatus } from "../gateway/events.js";
import { AccountLock } from "../session/account-lock.js";
import { loadSession } from "../session/loader.js";
import { parseSessionExport } from "../session/schema.js";
import { AtomicJsonStore } from "../session/state-store.js";
import { AuthProvider } from "../transport/auth-provider.js";
import { refreshSnapchatSession } from "../transport/sso-auth-refresh.js";
import type { ConfiguredGatewayStatusClient, GatewayStatusClient } from "./commands/gateway-status.js";

type Session = Awaited<ReturnType<typeof loadSession>>;

function assertSession(config: ReturnType<typeof loadConfig>, session: Session): void {
  if (session.accountId !== config.accountId) throw new Error("Configured account does not match the session export");
  if (session.buildId !== config.buildId) throw new Error("Configured build does not match the session export");
}

export async function createConfiguredGatewayStatusClient(): Promise<ConfiguredGatewayStatusClient> {
  loadEnvironmentFile();
  const config = loadConfig();
  const initialSession = applyCookieOverrides(await loadSession(config.sessionFile), {
    ...(config.cookieHeader === undefined ? {} : { cookieHeader: config.cookieHeader }),
    ...(config.ssoCookieHeader === undefined ? {} : { ssoCookieHeader: config.ssoCookieHeader }),
  });
  assertSession(config, initialSession);
  const lock = await new AccountLock(join(dirname(config.sessionFile), "locks")).acquire(config.accountId);
  try {
    const sessionStore = new AtomicJsonStore(config.sessionFile, parseSessionExport);
    const auth = new AuthProvider(initialSession, {
      refresh: (session) => refreshSnapchatSession(session, {
        attestation: (value) => finalizeWebAttestation(value.accountId, { assetDir: config.assetDir }),
      }),
      persist: async (refreshed) => {
        const latest = await sessionStore.read();
        await sessionStore.write({ ...latest, exportedAt: refreshed.exportedAt, auth: refreshed.auth });
      },
    });
    await auth.getRequestAuth();
    const gateway = new GatewayClient({ auth });
    let closed = false;
    const client: GatewayStatusClient = {
      watchEvents: async () => {
        await gateway.connect();
        return gateway.events();
      },
      status: (): GatewayStatus => gateway.status(),
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await gateway.close();
        } finally {
          await lock.release();
        }
      },
    };
    return { client, output: config.output };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

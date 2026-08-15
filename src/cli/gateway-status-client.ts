import { applyCookieOverrides } from "../auth/cookie-overrides.js";
import { finalizeWebAttestation } from "../auth/web-attestation.js";
import { getBuildProfile, type BuildId } from "../builds.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../config.js";
import { GatewayClient } from "../gateway/client.js";
import type { GatewayStatus } from "../gateway/events.js";
import { AccountLock } from "../session/account-lock.js";
import { loadSession } from "../session/loader.js";
import { SealedSessionStore } from "../session/sealed-store.js";
import { AuthProvider } from "../transport/auth-provider.js";
import { refreshSnapchatSession } from "../transport/sso-auth-refresh.js";
import type { ConfiguredGatewayStatusClient, GatewayStatusClient } from "./commands/gateway-status.js";

type Session = Awaited<ReturnType<typeof loadSession>>;

export function assertGatewayRuntimeBuild(buildId: BuildId): void {
  getBuildProfile(buildId);
}

function assertSession(config: AppConfig, session: Session): void {
  if (session.accountId !== config.accountId) throw new Error("Configured account does not match the session export");
  if (session.buildId !== config.buildId) throw new Error("Configured build does not match the session export");
  assertGatewayRuntimeBuild(session.buildId);
}

export async function createConfiguredGatewayStatusClient(config?: AppConfig): Promise<ConfiguredGatewayStatusClient> {
  const selectedConfig = config ?? (() => {
    loadEnvironmentFile();
    return loadConfig();
  })();
  const sessionStore = new SealedSessionStore(selectedConfig.sessionFile);
  const initialSession = applyCookieOverrides(await sessionStore.readOrMigrateLegacy(), {
    ...(selectedConfig.cookieHeader === undefined ? {} : { cookieHeader: selectedConfig.cookieHeader }),
    ...(selectedConfig.ssoCookieHeader === undefined ? {} : { ssoCookieHeader: selectedConfig.ssoCookieHeader }),
  });
  assertSession(selectedConfig, initialSession);
  const lock = await new AccountLock(selectedConfig.lockDir).acquire(selectedConfig.accountId);
  try {
    const auth = new AuthProvider(initialSession, {
      refresh: (session) => refreshSnapchatSession(session, {
        attestation: (value) => finalizeWebAttestation(value.accountId, {
          assetDir: selectedConfig.assetDir,
          buildId: value.buildId,
        }),
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
    return { client, output: selectedConfig.output };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

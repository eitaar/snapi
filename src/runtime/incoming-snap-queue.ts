import { AppError } from "../errors.js";
import type { IncomingSnap } from "./content-types.js";
import type { OfficialIncomingSnapCandidate } from "./official-incoming-snap.js";

export const MAX_PENDING_INCOMING_SNAPS = 16;
export const MAX_RESOLVED_LAYERS_PER_SNAP = 8;
export const MAX_RESOLVED_BYTES_PER_SNAP = 64 * 1024 * 1024;

type SnapResolver = (candidate: OfficialIncomingSnapCandidate) => Promise<IncomingSnap>;

export class IncomingSnapQueue {
  private active = false;
  private overflowed = false;
  private readonly pending: OfficialIncomingSnapCandidate[] = [];

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.overflowed = false;
      this.pending.splice(0);
    }
  }

  enqueue(candidates: readonly OfficialIncomingSnapCandidate[]): void {
    if (!this.active || candidates.length === 0) return;
    const available = Math.max(0, MAX_PENDING_INCOMING_SNAPS - this.pending.length);
    this.pending.push(...candidates.slice(0, available));
    if (candidates.length > available) this.overflowed = true;
  }

  async drain(resolve: SnapResolver): Promise<readonly IncomingSnap[]> {
    if (!this.active) return [];
    if (this.overflowed) {
      this.overflowed = false;
      this.pending.splice(0);
      throw new AppError(
        "CRYPTO_RUNTIME_FAILED",
        "Incoming Snap queue limit was exceeded",
        { maxPendingSnaps: MAX_PENDING_INCOMING_SNAPS },
      );
    }
    const candidates = this.pending.splice(0);
    const resolved: IncomingSnap[] = [];
    for (const candidate of candidates) resolved.push(await resolve(candidate));
    return resolved;
  }
}

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LeaseLostError, heartbeatLease, releaseLease } from '../database/leases';
import { Logger } from '../utils/logger';
import type { RunLeaseIdentity } from '../types';

/**
 * Identifies one worker process for the life of that process.
 *
 * Host and pid make an abandoned lease traceable to a machine an operator can
 * inspect; the random suffix keeps two workers distinct after a pid is reused.
 */
export function createLeaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

export interface RunLeaseOptions {
  identity: RunLeaseIdentity;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  onLost?: (identity: RunLeaseIdentity) => void;
  /** Overridden in tests; production always uses the real lease store. */
  heartbeat?: (lease: RunLeaseIdentity, leaseTtlMs: number) => Promise<boolean>;
  release?: (lease: RunLeaseIdentity) => Promise<boolean>;
}

/**
 * Keeps one run's lease alive and reports the moment it is no longer held.
 *
 * The heartbeat is advisory: it lets a displaced run stop early instead of
 * grinding through a window whose results it can never publish. The binding
 * check is the fence inside the finalizing transaction, which is the only
 * place a lost lease can actually cost correctness.
 */
export class RunLease {
  private timer: NodeJS.Timeout | null = null;
  private lost = false;
  private readonly heartbeat: (lease: RunLeaseIdentity, ttlMs: number) => Promise<boolean>;
  private readonly releaseLeaseFn: (lease: RunLeaseIdentity) => Promise<boolean>;

  constructor(private readonly options: RunLeaseOptions) {
    this.heartbeat = options.heartbeat ?? heartbeatLease;
    this.releaseLeaseFn = options.release ?? releaseLease;
  }

  get identity(): RunLeaseIdentity {
    return this.options.identity;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.beat();
    }, this.options.heartbeatIntervalMs);

    // A pending heartbeat must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  private async beat(): Promise<void> {
    try {
      if (await this.heartbeat(this.identity, this.options.leaseTtlMs)) {
        return;
      }
    } catch (error: unknown) {
      // A failed heartbeat write is not proof the lease was taken — the
      // database may simply be unreachable. Leave the lease presumed held; if
      // the outage outlasts the TTL the finalize fence will refuse the run.
      Logger.warn('Reconciliation lease heartbeat failed; lease presumed still held', {
        runKey: this.identity.runKey,
        owner: this.identity.owner,
        epoch: this.identity.epoch,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.markLost();
  }

  private markLost(): void {
    if (this.lost) {
      return;
    }

    this.lost = true;
    this.stop();

    Logger.error('Reconciliation lease lost; the run will publish nothing', {
      runKey: this.identity.runKey,
      owner: this.identity.owner,
      epoch: this.identity.epoch,
    });

    this.options.onLost?.(this.identity);
  }

  /** Bail out at a batch boundary rather than after the whole window. */
  assertHeld(): void {
    if (this.lost) {
      throw new LeaseLostError(this.identity);
    }
  }

  get isLost(): boolean {
    return this.lost;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stop beating and hand the lease back.
   *
   * A released lease is not an abandoned one: the run reached a terminal status
   * and the next worker should find the key free rather than wait out a TTL.
   */
  async release(): Promise<void> {
    this.stop();

    if (this.lost) {
      return;
    }

    try {
      await this.releaseLeaseFn(this.identity);
    } catch (error: unknown) {
      // The run's own status is already committed. A stranded lease only costs
      // the next worker a TTL wait, so this must not fail the run.
      Logger.warn('Could not release the reconciliation lease; it will expire instead', {
        runKey: this.identity.runKey,
        owner: this.identity.owner,
        epoch: this.identity.epoch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

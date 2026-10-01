import { randomUUID } from 'node:crypto';
import type { NonceStore } from '@agroasys/shared-auth';

export interface RelayerReadinessDependency {
  name: string;
  required: true;
  status: 'ok' | 'unavailable';
  reason?: 'failed' | 'timeout';
}

export interface RelayerReadinessResult {
  ready: boolean;
  dependencies: RelayerReadinessDependency[];
}

export interface RelayerReadinessOptions {
  signerProbe: () => Promise<void>;
  /** Shared replay store; probed only when it is an external dependency (Redis). */
  replayStore?: NonceStore;
  timeoutMs?: number;
  /** A signer success is reused this long so readiness does not call KMS on every probe. */
  signerSuccessTtlMs?: number;
  now?: () => number;
}

export const RELAYER_SIGNER_READINESS_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;

async function runCheck(
  name: string,
  check: () => Promise<void>,
  timeoutMs: number,
): Promise<RelayerReadinessDependency> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('timeout'));
        }, timeoutMs);
      }),
    ]);
    return { name, required: true, status: 'ok' };
  } catch {
    // Error text is never returned: KMS and Redis errors can name keys, hosts, or accounts.
    return { name, required: true, status: 'unavailable', reason: timedOut ? 'timeout' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The relayer can only serve when it can sign with the reviewed KMS key and, when replay
 * protection is shared, record request identities. Liveness stays at /health.
 */
export function createRelayerReadinessCheck(
  options: RelayerReadinessOptions,
): () => Promise<RelayerReadinessResult> {
  const now = options.now ?? Date.now;
  const ttlMs = options.signerSuccessTtlMs ?? RELAYER_SIGNER_READINESS_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let signerOkUntil = 0;

  const signer = async () => {
    if (now() < signerOkUntil) {
      return;
    }
    await options.signerProbe();
    signerOkUntil = now() + ttlMs;
  };

  const replayStore = options.replayStore;
  const replay = async () => {
    if (!(await replayStore!.consume('readiness', randomUUID(), 5))) {
      throw new Error('replay store refused a fresh readiness nonce');
    }
  };

  return async () => {
    const dependencies = await Promise.all([
      runCheck('kms-signer', signer, timeoutMs),
      ...(replayStore ? [runCheck('replay-store', replay, timeoutMs)] : []),
    ]);
    return {
      ready: dependencies.every((dependency) => dependency.status === 'ok'),
      dependencies,
    };
  };
}

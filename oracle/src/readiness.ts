import {
  cacheSuccessfulCheck,
  evaluateReadiness,
  type ReadinessResult,
} from '@agroasys/shared-edge';

export interface OracleReadinessDependencies {
  database: () => Promise<void>;
  rpc: () => Promise<void>;
  signer: () => Promise<void>;
  indexer: () => Promise<void>;
  containment: () => Promise<void>;
  /**
   * Whether containment is part of this profile. `required` (the default) fails readiness unless
   * the guard can answer, including when no reader is configured; `disabled` is only for local
   * and test profiles that run without a reconciliation reader, and is never reported as ok.
   */
  containmentMode?: 'required' | 'disabled';
  timeoutMs?: number;
  /** A signer success is reused this long so readiness does not call KMS on every probe. */
  signerSuccessTtlMs?: number;
  now?: () => number;
}

export const ORACLE_SIGNER_READINESS_TTL_MS = 60_000;

/**
 * The oracle can only settle when it can persist, read the chain, sign, confirm against the
 * indexer, and consult reconciliation containment. Each is required: without any one of them a
 * milestone either cannot be submitted or cannot be proven, so the oracle is not ready.
 */
export function createOracleReadinessCheck(
  dependencies: OracleReadinessDependencies,
): () => Promise<ReadinessResult> {
  const signer = cacheSuccessfulCheck(
    dependencies.signer,
    dependencies.signerSuccessTtlMs ?? ORACLE_SIGNER_READINESS_TTL_MS,
    dependencies.now,
  );

  return () =>
    evaluateReadiness(
      [
        { name: 'postgres', check: dependencies.database },
        { name: 'chain-rpc', check: dependencies.rpc },
        { name: 'oracle-signer', check: signer },
        { name: 'indexer-graphql', check: dependencies.indexer },
        {
          name: 'reconciliation-containment',
          check: dependencies.containment,
          disabled: dependencies.containmentMode === 'disabled',
        },
      ],
      { defaultTimeoutMs: dependencies.timeoutMs },
    );
}

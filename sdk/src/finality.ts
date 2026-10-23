/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SettlementConfirmationStage } from './confirmation';

/**
 * WP-2 H-02. One versioned vocabulary for what Cotsel knows about a broadcast
 * transaction. Every service maps its own persisted statuses onto these states
 * and none may report a stronger state than the evidence classified here.
 * Bump the version when a state, rule or reason changes meaning.
 */
export const TRANSACTION_FINALITY_MODEL_VERSION = 'cotsel.transaction-finality.v1' as const;

export const TRANSACTION_FINALITY_STATES = [
  'submitted',
  'confirmed',
  'safe',
  'finalized',
  'reverted',
  'replaced',
  'unknown',
  'failed',
] as const;

export type TransactionFinalityState = (typeof TRANSACTION_FINALITY_STATES)[number];

/** How deep the receipt (or the replacing transaction) sits by the chain's own block tags. */
export type TransactionFinalityDepth = 'none' | 'included' | 'safe' | 'finalized';

export type TransactionFinalityReason =
  | 'rejected_before_broadcast'
  | 'contradicts_rejection'
  | 'awaiting_receipt'
  | 'ambiguous_broadcast'
  | 'insufficient_providers'
  | 'invalid_observation'
  | 'wrong_chain'
  | 'provider_disagreement'
  | 'receipt_not_canonical'
  | 'included'
  | 'finality_tag_unsupported'
  | 'safe_tag_reached'
  | 'finalized_tag_reached';

/**
 * A provider's answer for a block tag: the block number, `null` when the
 * provider returned no block, or `'unsupported'` when it rejected the tag.
 * Confirmation counts are never a substitute for a missing tag.
 */
export type FinalityTagObservation = number | null | 'unsupported';

export interface TransactionFinalityObservation {
  /** Stable, non-secret provider identity (for example a hash of the endpoint). */
  providerId: string;
  chainId: number;
  latestBlockNumber: number;
  safeBlockNumber: FinalityTagObservation;
  finalizedBlockNumber: FinalityTagObservation;
  receipt: { blockNumber: number; blockHash: string; status: 0 | 1 } | null;
  /** Hash of this provider's canonical block at `receipt.blockNumber`, when a receipt exists. */
  canonicalBlockHash: string | null;
  /** A different transaction that consumed the same sender nonce, when observed. */
  replacement?: { transactionHash: string; blockNumber: number; blockHash: string } | null;
}

export interface TransactionFinalityInput {
  expectedChainId: number;
  /**
   * `rejected`: provably never broadcast. `broadcast`: the send was accepted.
   * `ambiguous`: the send may or may not have reached the network.
   */
  submission: 'rejected' | 'broadcast' | 'ambiguous';
  observations: readonly TransactionFinalityObservation[];
  /** Independent providers that must agree before anything above submission is reported. */
  minimumProviders?: number;
}

export interface TransactionFinalityAssessment {
  modelVersion: typeof TRANSACTION_FINALITY_MODEL_VERSION;
  state: TransactionFinalityState;
  depth: TransactionFinalityDepth;
  /** True only when no later observation can change the state. */
  final: boolean;
  reason: TransactionFinalityReason;
  blockNumber: number | null;
  blockHash: string | null;
  providerIds: string[];
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DEPTH_RANK: Record<TransactionFinalityDepth, number> = {
  none: 0,
  included: 1,
  safe: 2,
  finalized: 3,
};

function isBlockNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTagObservation(value: FinalityTagObservation): boolean {
  return value === null || value === 'unsupported' || isBlockNumber(value);
}

function isValidObservation(observation: TransactionFinalityObservation): boolean {
  const { receipt, replacement, latestBlockNumber, safeBlockNumber, finalizedBlockNumber } =
    observation;
  if (
    typeof observation.providerId !== 'string' ||
    observation.providerId.length === 0 ||
    !isBlockNumber(observation.chainId) ||
    !isBlockNumber(latestBlockNumber) ||
    !isTagObservation(safeBlockNumber) ||
    !isTagObservation(finalizedBlockNumber)
  ) {
    return false;
  }
  if (typeof safeBlockNumber === 'number' && safeBlockNumber > latestBlockNumber) return false;
  if (typeof finalizedBlockNumber === 'number' && finalizedBlockNumber > latestBlockNumber) {
    return false;
  }
  if (
    typeof safeBlockNumber === 'number' &&
    typeof finalizedBlockNumber === 'number' &&
    finalizedBlockNumber > safeBlockNumber
  ) {
    return false;
  }
  if (receipt) {
    if (
      !isBlockNumber(receipt.blockNumber) ||
      receipt.blockNumber > latestBlockNumber ||
      !HASH_PATTERN.test(receipt.blockHash) ||
      (receipt.status !== 0 && receipt.status !== 1) ||
      (observation.canonicalBlockHash !== null &&
        !HASH_PATTERN.test(observation.canonicalBlockHash))
    ) {
      return false;
    }
  }
  if (replacement) {
    if (
      receipt ||
      !HASH_PATTERN.test(replacement.transactionHash) ||
      !HASH_PATTERN.test(replacement.blockHash) ||
      !isBlockNumber(replacement.blockNumber) ||
      replacement.blockNumber > latestBlockNumber
    ) {
      return false;
    }
  }
  return true;
}

function depthAt(observation: TransactionFinalityObservation, blockNumber: number) {
  const { safeBlockNumber, finalizedBlockNumber } = observation;
  if (typeof finalizedBlockNumber === 'number' && finalizedBlockNumber >= blockNumber) {
    return 'finalized' as const;
  }
  if (typeof safeBlockNumber === 'number' && safeBlockNumber >= blockNumber) {
    return 'safe' as const;
  }
  return 'included' as const;
}

/** What every provider must agree on before the observations count as one answer. */
function agreementKey(observation: TransactionFinalityObservation): string {
  if (observation.receipt) {
    const { blockNumber, blockHash, status } = observation.receipt;
    return `receipt:${blockNumber}:${blockHash.toLowerCase()}:${status}`;
  }
  if (observation.replacement) {
    const { transactionHash, blockNumber, blockHash } = observation.replacement;
    return `replacement:${transactionHash.toLowerCase()}:${blockNumber}:${blockHash.toLowerCase()}`;
  }
  return 'none';
}

/**
 * Classifies one transaction from independent provider observations. Any
 * wrong chain, invalid answer, non-canonical receipt or disagreement yields
 * `unknown`; the weakest depth any provider reports wins.
 */
export function classifyTransactionFinality(
  input: TransactionFinalityInput,
): TransactionFinalityAssessment {
  const providerIds = input.observations.map((observation) => observation.providerId);
  const result = (
    state: TransactionFinalityState,
    reason: TransactionFinalityReason,
    extra: Partial<
      Pick<TransactionFinalityAssessment, 'depth' | 'final' | 'blockNumber' | 'blockHash'>
    > = {},
  ): TransactionFinalityAssessment => ({
    modelVersion: TRANSACTION_FINALITY_MODEL_VERSION,
    state,
    depth: extra.depth ?? 'none',
    final: extra.final ?? false,
    reason,
    blockNumber: extra.blockNumber ?? null,
    blockHash: extra.blockHash ?? null,
    providerIds,
  });
  const unobserved = () =>
    input.submission === 'broadcast'
      ? result('submitted', 'awaiting_receipt')
      : result('unknown', 'ambiguous_broadcast');

  if (!input.observations.every(isValidObservation))
    return result('unknown', 'invalid_observation');
  if (input.observations.some((observation) => observation.chainId !== input.expectedChainId)) {
    return result('unknown', 'wrong_chain');
  }

  if (input.submission === 'rejected') {
    return input.observations.some((observation) => observation.receipt || observation.replacement)
      ? result('unknown', 'contradicts_rejection')
      : result('failed', 'rejected_before_broadcast', { final: true });
  }

  const minimumProviders = Math.max(1, input.minimumProviders ?? 1);
  if (new Set(providerIds).size < minimumProviders || providerIds.length < minimumProviders) {
    return input.submission === 'broadcast'
      ? result('submitted', 'insufficient_providers')
      : result('unknown', 'insufficient_providers');
  }

  const keys = new Set(input.observations.map(agreementKey));
  if (keys.size !== 1) return result('unknown', 'provider_disagreement');

  const [first] = input.observations;
  const anchor = first.receipt ?? first.replacement ?? null;
  if (!anchor) return unobserved();

  if (
    first.receipt &&
    input.observations.some(
      (observation) =>
        observation.canonicalBlockHash?.toLowerCase() !== first.receipt?.blockHash.toLowerCase(),
    )
  ) {
    return result('unknown', 'receipt_not_canonical');
  }

  const depth = input.observations
    .map((observation) => depthAt(observation, anchor.blockNumber))
    .reduce((weakest, next) => (DEPTH_RANK[next] < DEPTH_RANK[weakest] ? next : weakest));
  const final = depth === 'finalized';
  const reason: TransactionFinalityReason =
    depth === 'finalized'
      ? 'finalized_tag_reached'
      : depth === 'safe'
        ? 'safe_tag_reached'
        : input.observations.some(
              (observation) => observation.finalizedBlockNumber === 'unsupported',
            )
          ? 'finality_tag_unsupported'
          : 'included';
  const located = {
    depth,
    final,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash.toLowerCase(),
  };

  if (first.replacement) return result('replaced', reason, located);
  if (first.receipt?.status === 0) return result('reverted', reason, located);
  const successState: TransactionFinalityState =
    depth === 'finalized' ? 'finalized' : depth === 'safe' ? 'safe' : 'confirmed';
  return result(successState, reason, located);
}

export interface TransactionFinalityPosition {
  state: TransactionFinalityState;
  final: boolean;
}

const SUCCESS_RANK: Partial<Record<TransactionFinalityState, number>> = {
  confirmed: 1,
  safe: 2,
  finalized: 3,
};

/**
 * Whether a stored position may move to a newly classified one. Final
 * positions never move; `failed` is only ever an initial position; a
 * successful depth may rise but only falls by passing through `unknown`.
 */
export function canTransitionTransactionFinality(
  from: TransactionFinalityPosition | null,
  to: TransactionFinalityPosition,
): boolean {
  if (to.state === 'finalized' && !to.final) return false;
  if (to.state === 'failed' && !to.final) return false;
  if (from === null) return true;
  if (from.state === to.state && from.final === to.final) return true;
  if (from.final) return false;
  if (to.state === 'failed') return false;
  const fromRank = SUCCESS_RANK[from.state];
  const toRank = SUCCESS_RANK[to.state];
  if (fromRank !== undefined && toRank !== undefined) return toRank > fromRank;
  return true;
}

export function assertTransactionFinalityTransition(
  from: TransactionFinalityPosition | null,
  to: TransactionFinalityPosition,
): void {
  if (!canTransitionTransactionFinality(from, to)) {
    throw new Error(
      `Transaction finality cannot move from ${from ? `${from.state}${from.final ? ' (final)' : ''}` : 'nothing'} to ${to.state}${to.final ? ' (final)' : ''}`,
    );
  }
}

/** Only a finalized success may be treated as settled chain truth. */
export function isFinalizedSuccess(position: TransactionFinalityPosition): boolean {
  return position.state === 'finalized' && position.final;
}

/** Indexed settlement events are already included, so their stage is a depth only. */
export function finalityFromConfirmationStage(
  stage: SettlementConfirmationStage,
): TransactionFinalityPosition {
  switch (stage) {
    case 'FINALIZED':
      return { state: 'finalized', final: true };
    case 'SAFE':
      return { state: 'safe', final: false };
    case 'INDEXED':
      return { state: 'confirmed', final: false };
  }
}

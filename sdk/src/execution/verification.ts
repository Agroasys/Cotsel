/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress, sha256, toUtf8Bytes, Transaction } from 'ethers';
import {
  ManagedSignerValidationError,
  type ManagedSignerTransactionIntent,
  validateManagedSignerTransaction,
} from '../managedSignerIntent';
import {
  isExactAmount,
  parseExactAmount,
  serializeExactAmount,
  type SerializedExactAmount,
} from './amount';
import type { ExecutionCapability, ExecutionObservation, ExecutionPayloads } from './adapters';

/**
 * What a successful operation must report, kept in serializable form so it can
 * be stored with the idempotency claim and checked again on every status read.
 */
export type ExpectedExecutionObservation =
  | { kind: 'wallet' }
  | { kind: 'signature'; intent: ManagedSignerTransactionIntent }
  | { kind: 'transfer'; amount: SerializedExactAmount; recipient: string }
  | { kind: 'transaction'; transactionHash: string };

export type ExecutionObservationMismatch =
  | 'observation_missing'
  | 'asset_mismatch'
  | 'amount_mismatch'
  | 'recipient_mismatch'
  | 'wallet_address_invalid'
  | 'transaction_hash_mismatch'
  | `signature_${string}`;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveChainId(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function amountProblems(amount: unknown): string[] {
  if (!isExactAmount(amount)) {
    return ['amount_invalid'];
  }
  return amount.baseUnits > 0n ? [] : ['amount_not_positive'];
}

/** Structural problems with a payload. An empty list means it may be routed. */
export function executionPayloadProblems<C extends ExecutionCapability>(
  capability: C,
  payload: ExecutionPayloads[C],
): string[] {
  if (typeof payload !== 'object' || payload === null) {
    return ['payload_missing'];
  }
  const problems: string[] = [];
  switch (capability) {
    case 'wallet': {
      const wallet = payload as ExecutionPayloads['wallet'];
      if (!nonEmpty(wallet.participantRef)) problems.push('participant_ref_missing');
      if (!positiveChainId(wallet.chainId)) problems.push('chain_id_invalid');
      break;
    }
    case 'signing': {
      const { intent } = payload as ExecutionPayloads['signing'];
      if (typeof intent !== 'object' || intent === null) {
        problems.push('intent_missing');
      } else {
        if (!nonEmpty(intent.requestId)) problems.push('intent_request_id_missing');
        if (!isAddress(intent.signerAddress)) problems.push('intent_signer_invalid');
        if (!positiveChainId(intent.chainId)) problems.push('chain_id_invalid');
      }
      break;
    }
    case 'funding': {
      const funding = payload as ExecutionPayloads['funding'];
      if (!positiveChainId(funding.chainId)) problems.push('chain_id_invalid');
      if (!nonEmpty(funding.payerRef)) problems.push('payer_ref_missing');
      if (!isAddress(funding.destination)) problems.push('destination_invalid');
      problems.push(...amountProblems(funding.amount));
      break;
    }
    case 'payout': {
      const payout = payload as ExecutionPayloads['payout'];
      if (!nonEmpty(payout.recipientRef)) problems.push('recipient_ref_missing');
      problems.push(...amountProblems(payout.amount));
      break;
    }
    case 'ramp': {
      const ramp = payload as ExecutionPayloads['ramp'];
      if (ramp.direction !== 'on_ramp' && ramp.direction !== 'off_ramp') {
        problems.push('direction_invalid');
      }
      if (!nonEmpty(ramp.sourceRef)) problems.push('source_ref_missing');
      if (!nonEmpty(ramp.destinationRef)) problems.push('destination_ref_missing');
      problems.push(...amountProblems(ramp.amount));
      break;
    }
    case 'chain': {
      const chain = payload as ExecutionPayloads['chain'];
      if (!positiveChainId(chain.chainId)) problems.push('chain_id_invalid');
      try {
        Transaction.from(chain.signedTransaction);
      } catch {
        problems.push('signed_transaction_invalid');
      }
      break;
    }
    default:
      problems.push('capability_unknown');
  }
  return problems;
}

/** Call only after `executionPayloadProblems` returned no problems. */
export function expectedExecutionObservation<C extends ExecutionCapability>(
  capability: C,
  payload: ExecutionPayloads[C],
): ExpectedExecutionObservation {
  switch (capability) {
    case 'wallet':
      return { kind: 'wallet' };
    case 'signing':
      return { kind: 'signature', intent: (payload as ExecutionPayloads['signing']).intent };
    case 'funding': {
      const funding = payload as ExecutionPayloads['funding'];
      return {
        kind: 'transfer',
        amount: serializeExactAmount(funding.amount),
        recipient: funding.destination,
      };
    }
    case 'payout': {
      const payout = payload as ExecutionPayloads['payout'];
      return {
        kind: 'transfer',
        amount: serializeExactAmount(payout.amount),
        recipient: payout.recipientRef,
      };
    }
    case 'ramp': {
      const ramp = payload as ExecutionPayloads['ramp'];
      return {
        kind: 'transfer',
        amount: serializeExactAmount(ramp.amount),
        recipient: ramp.destinationRef,
      };
    }
    case 'chain':
      return {
        kind: 'transaction',
        transactionHash: Transaction.from((payload as ExecutionPayloads['chain']).signedTransaction)
          .hash as string,
      };
    default:
      throw new TypeError(`Unknown execution capability ${String(capability)}`);
  }
}

function sameRecipient(expected: string, observed: string): boolean {
  if (isAddress(expected) && isAddress(observed)) {
    return getAddress(expected) === getAddress(observed);
  }
  return expected === observed;
}

/**
 * Compares what the provider reports with what was requested. A `succeeded`
 * outcome must carry a full observation; any other outcome is checked only for
 * the fields it reports. Returns null when the observation is acceptable.
 */
export function verifyExecutionObservation(
  expected: ExpectedExecutionObservation,
  outcome: string,
  observation: ExecutionObservation | undefined,
): ExecutionObservationMismatch | null {
  const mustReport = outcome === 'succeeded';
  const observed = observation ?? {};
  switch (expected.kind) {
    case 'wallet':
      if (observed.address === undefined) {
        return mustReport ? 'observation_missing' : null;
      }
      return isAddress(observed.address) ? null : 'wallet_address_invalid';
    case 'signature':
      if (observed.signedTransaction === undefined) {
        return mustReport ? 'observation_missing' : null;
      }
      try {
        validateManagedSignerTransaction(observed.signedTransaction, expected.intent);
        return null;
      } catch (error) {
        return error instanceof ManagedSignerValidationError
          ? `signature_${error.reason}`
          : 'signature_invalid';
      }
    case 'transfer': {
      if (mustReport && (observed.amount === undefined || observed.recipient === undefined)) {
        return 'observation_missing';
      }
      if (observed.amount !== undefined) {
        const want = parseExactAmount(expected.amount);
        if (!isExactAmount(observed.amount)) return 'amount_mismatch';
        if (observed.amount.asset !== want.asset) return 'asset_mismatch';
        if (observed.amount.baseUnits !== want.baseUnits) return 'amount_mismatch';
      }
      if (
        observed.recipient !== undefined &&
        !sameRecipient(expected.recipient, observed.recipient)
      ) {
        return 'recipient_mismatch';
      }
      return null;
    }
    case 'transaction':
      if (observed.transactionHash === undefined) {
        return mustReport ? 'observation_missing' : null;
      }
      return observed.transactionHash.toLowerCase() === expected.transactionHash.toLowerCase()
        ? null
        : 'transaction_hash_mismatch';
    default:
      return 'observation_missing';
  }
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** SHA-256 over canonical JSON: key order does not matter, bigints are exact. */
export function canonicalExecutionHash(value: unknown): string {
  return sha256(toUtf8Bytes(JSON.stringify(canonicalize(value))));
}

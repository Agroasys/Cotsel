/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ManagedSignerTransactionIntent } from '../managedSignerIntent';
import type { ExactAmount } from './amount';
import { assertCustodyPermits, type CustodyMode, isCustodyMode } from './custody';

/** One interface per execution capability. */
export const EXECUTION_CAPABILITIES = [
  'wallet',
  'signing',
  'funding',
  'payout',
  'ramp',
  'chain',
] as const;

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

export function isExecutionCapability(value: unknown): value is ExecutionCapability {
  return typeof value === 'string' && (EXECUTION_CAPABILITIES as readonly string[]).includes(value);
}

/** Resolve or provision the wallet address a participant settles from. */
export interface WalletPayload {
  participantRef: string;
  chainId: number;
}

/**
 * Sign one approved transaction intent. The signed result is checked against the
 * intent with `validateManagedSignerTransaction` (#645) before it is accepted;
 * who holds the key is the adapter's declared custody class (#649).
 */
export interface SigningPayload {
  intent: ManagedSignerTransactionIntent;
}

/** Move funds from a payer into a destination, normally the escrow. */
export interface FundingPayload {
  chainId: number;
  payerRef: string;
  /** EVM address that must receive exactly `amount`. */
  destination: string;
  amount: ExactAmount;
}

/** Pay a recipient: an EVM address or a provider beneficiary reference. */
export interface PayoutPayload {
  recipientRef: string;
  amount: ExactAmount;
}

/** Convert between the settlement asset and an external rail. */
export interface RampPayload {
  direction: 'on_ramp' | 'off_ramp';
  sourceRef: string;
  destinationRef: string;
  amount: ExactAmount;
}

/** Broadcast one signed transaction to one chain. */
export interface ChainPayload {
  chainId: number;
  signedTransaction: string;
}

export interface ExecutionPayloads {
  wallet: WalletPayload;
  signing: SigningPayload;
  funding: FundingPayload;
  payout: PayoutPayload;
  ramp: RampPayload;
  chain: ChainPayload;
}

export interface ExecutionAdapterDescriptor<C extends ExecutionCapability = ExecutionCapability> {
  /** Stable identifier used in configuration, for example `aws-kms-signer`. */
  id: string;
  capability: C;
  /** The most custody this adapter takes. The firewall compares it with the mode. */
  custodyClass: CustodyMode;
  version: string;
}

/**
 * Outcome of a submit or a status read.
 *
 * - `pending`: the provider accepted the operation and it has not finished.
 * - `succeeded`: the provider confirmed completion, with an observation.
 * - `failed`: the provider confirmed the operation did not and will not happen.
 * - `unknown`: Cotsel cannot tell (timeout, lost response, mismatch). Recover
 *   through `status` (#644); never resubmit blindly and never treat as success.
 */
export type ExecutionOutcome = 'pending' | 'succeeded' | 'failed' | 'unknown';

/** What the provider reports was actually done, compared with the request. */
export interface ExecutionObservation {
  amount?: ExactAmount;
  recipient?: string;
  address?: string;
  signedTransaction?: string;
  transactionHash?: string;
}

export interface ExecutionContext {
  /** Caller-chosen key; the same key must never cause a second provider operation. */
  idempotencyKey: string;
  /** Custody mode recorded on the settlement this call belongs to. */
  custodyMode: CustodyMode;
  settlementId: string | null;
}

export interface ExecutionStatusQuery {
  idempotencyKey: string;
  custodyMode: CustodyMode;
  /** Optional. Status must also resolve from the idempotency key alone. */
  operationRef?: string | null;
}

export interface ExecutionPreflightResult {
  ok: boolean;
  problems: string[];
}

export interface ExecutionSubmitResult {
  outcome: ExecutionOutcome;
  operationRef: string | null;
  observation?: ExecutionObservation;
  reason?: string;
}

export interface ExecutionStatusResult {
  outcome: ExecutionOutcome | 'not_found';
  operationRef: string | null;
  observation?: ExecutionObservation;
  reason?: string;
}

/**
 * The contract every execution adapter implements.
 *
 * - `preflight` checks a request without side effects.
 * - `submit` starts the operation once per idempotency key.
 * - `status` reports the operation for a key, `not_found` if there is none.
 */
export interface ExecutionAdapter<C extends ExecutionCapability = ExecutionCapability> {
  readonly descriptor: ExecutionAdapterDescriptor<C>;
  preflight(
    context: ExecutionContext,
    payload: ExecutionPayloads[C],
  ): Promise<ExecutionPreflightResult>;
  submit(context: ExecutionContext, payload: ExecutionPayloads[C]): Promise<ExecutionSubmitResult>;
  status(query: ExecutionStatusQuery): Promise<ExecutionStatusResult>;
}

export type AnyExecutionAdapter = {
  [C in ExecutionCapability]: ExecutionAdapter<C>;
}[ExecutionCapability];

const GUARDED = Symbol.for('agroasys.execution.guardedAdapter');

export function isGuardedExecutionAdapter(adapter: object): boolean {
  return (adapter as { [GUARDED]?: true })[GUARDED] === true;
}

function assertEntry(
  descriptor: ExecutionAdapterDescriptor,
  custodyMode: unknown,
  idempotencyKey: unknown,
): void {
  assertCustodyPermits(custodyMode, descriptor, 'adapter');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new TypeError(`Adapter ${descriptor.id} requires a non-empty idempotency key`);
  }
}

/**
 * Wraps an adapter so every entry point enforces the custody firewall itself,
 * independently of the router. Adapters must be exported through this function;
 * the router also applies it to anything registered with it.
 */
export function guardExecutionAdapter<C extends ExecutionCapability>(
  adapter: ExecutionAdapter<C>,
): ExecutionAdapter<C> {
  if (isGuardedExecutionAdapter(adapter)) {
    return adapter;
  }
  const descriptor = Object.freeze({ ...adapter.descriptor });
  const guarded: ExecutionAdapter<C> = {
    descriptor,
    async preflight(context, payload) {
      assertEntry(descriptor, context?.custodyMode, context?.idempotencyKey);
      return adapter.preflight(context, payload);
    },
    async submit(context, payload) {
      assertEntry(descriptor, context?.custodyMode, context?.idempotencyKey);
      return adapter.submit(context, payload);
    },
    async status(query) {
      assertEntry(descriptor, query?.custodyMode, query?.idempotencyKey);
      return adapter.status(query);
    },
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  return Object.freeze(guarded);
}

export function executionDescriptorProblems(descriptor: unknown): string[] {
  if (typeof descriptor !== 'object' || descriptor === null) {
    return ['descriptor_missing'];
  }
  const candidate = descriptor as Partial<ExecutionAdapterDescriptor>;
  const problems: string[] = [];
  if (typeof candidate.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate.id)) {
    problems.push('descriptor_id_invalid');
  }
  if (!isExecutionCapability(candidate.capability)) {
    problems.push('descriptor_capability_invalid');
  }
  if (!isCustodyMode(candidate.custodyClass)) {
    problems.push('descriptor_custody_class_invalid');
  }
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) {
    problems.push('descriptor_version_invalid');
  }
  return problems;
}

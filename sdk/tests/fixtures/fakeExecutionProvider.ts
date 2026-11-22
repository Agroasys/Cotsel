/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Transaction, Wallet } from 'ethers';
import {
  type CustodyMode,
  exactAmount,
  type ExecutionAdapter,
  type ExecutionCapability,
  type ExecutionObservation,
  type ExecutionPayloads,
  guardExecutionAdapter,
} from '../../src/execution';
import type { ManagedSignerTransactionIntent } from '../../src/managedSignerIntent';

export const signerWallet = new Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
export const ESCROW = '0x00000000000000000000000000000000000000E5';
export const USDC = 'usdc:base-sepolia';

export type FakeBehaviour =
  | 'honest'
  | 'pending'
  | 'hang'
  | 'throw_on_submit'
  | 'not_idempotent'
  | 'misreport_amount'
  | 'misreport_recipient'
  | 'success_without_observation'
  | 'sign_other_nonce';

export interface FakeProviderOptions {
  id?: string;
  custodyClass?: CustodyMode;
  behaviour?: FakeBehaviour;
  /** Skip `guardExecutionAdapter`, to prove the conformance suite catches it. */
  unguarded?: boolean;
}

export interface FakeProvider<C extends ExecutionCapability> {
  adapter: ExecutionAdapter<C>;
  operations(): number;
  /** Lets a pending operation complete, as the provider would later. */
  complete(idempotencyKey: string): void;
  setBehaviour(behaviour: FakeBehaviour): void;
}

function signIntent(intent: ManagedSignerTransactionIntent): Promise<string> {
  return signerWallet.signTransaction({
    chainId: intent.chainId,
    to: intent.to,
    data: intent.data,
    value: BigInt(intent.value),
    nonce: intent.nonce,
    gasLimit: BigInt(intent.gasLimit),
    type: 2,
    maxFeePerGas: BigInt(intent.maxFeePerGasWei ?? '0'),
    maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGasWei ?? '0'),
  });
}

export function signingIntent(nonce = 7): ManagedSignerTransactionIntent {
  return {
    requestId: `signer-request-${nonce}`,
    signerAddress: signerWallet.address,
    chainId: 84532,
    to: ESCROW,
    data: '0x12345678',
    value: '0',
    nonce,
    gasLimit: '210000',
    type: 2,
    maxFeePerGasWei: '1000000000',
    maxPriorityFeePerGasWei: '100000000',
  };
}

export async function signedTransaction(nonce = 7): Promise<string> {
  return signIntent(signingIntent(nonce));
}

let sequence = 0;

/** A fresh valid payload per capability. `chain` needs a pre-signed transaction. */
export function validPayload<C extends ExecutionCapability>(
  capability: C,
  presigned: string,
): ExecutionPayloads[C] {
  sequence += 1;
  const payloads: ExecutionPayloads = {
    wallet: { participantRef: `participant-${sequence}`, chainId: 84532 },
    signing: { intent: signingIntent(7) },
    funding: {
      chainId: 84532,
      payerRef: `buyer-${sequence}`,
      destination: ESCROW,
      amount: exactAmount(USDC, 1_000_000n),
    },
    payout: { recipientRef: `beneficiary-${sequence}`, amount: exactAmount(USDC, 2_500_000n) },
    ramp: {
      direction: 'off_ramp',
      sourceRef: `wallet-${sequence}`,
      destinationRef: `bank-${sequence}`,
      amount: exactAmount(USDC, 3_000_000n),
    },
    chain: { chainId: 84532, signedTransaction: presigned },
  };
  return payloads[capability];
}

async function honestObservation<C extends ExecutionCapability>(
  capability: C,
  payload: ExecutionPayloads[C],
  behaviour: FakeBehaviour,
): Promise<ExecutionObservation> {
  switch (capability) {
    case 'wallet':
      return { address: signerWallet.address };
    case 'signing': {
      const { intent } = payload as ExecutionPayloads['signing'];
      const nonce = behaviour === 'sign_other_nonce' ? intent.nonce + 1 : intent.nonce;
      return { signedTransaction: await signIntent({ ...intent, nonce }) };
    }
    case 'chain':
      return {
        transactionHash: Transaction.from((payload as ExecutionPayloads['chain']).signedTransaction)
          .hash as string,
      };
    default: {
      const transfer = payload as ExecutionPayloads['funding' | 'payout' | 'ramp'];
      const recipient =
        'destination' in transfer
          ? transfer.destination
          : 'recipientRef' in transfer
            ? transfer.recipientRef
            : transfer.destinationRef;
      return {
        amount:
          behaviour === 'misreport_amount'
            ? exactAmount(transfer.amount.asset, transfer.amount.baseUnits - 1n)
            : transfer.amount,
        recipient: behaviour === 'misreport_recipient' ? 'someone-else' : recipient,
      };
    }
  }
}

interface Operation {
  operationRef: string;
  observation: ExecutionObservation;
  completed: boolean;
}

export function createFakeProvider<C extends ExecutionCapability>(
  capability: C,
  options: FakeProviderOptions = {},
): FakeProvider<C> {
  let behaviour = options.behaviour ?? 'honest';
  const byKey = new Map<string, Operation>();
  let performed = 0;

  const result = (operation: Operation) => {
    if (!operation.completed) {
      return { outcome: 'pending' as const, operationRef: operation.operationRef };
    }
    return {
      outcome: 'succeeded' as const,
      operationRef: operation.operationRef,
      ...(behaviour === 'success_without_observation'
        ? {}
        : { observation: operation.observation }),
    };
  };

  const raw: ExecutionAdapter<C> = {
    descriptor: {
      id: options.id ?? `fake-${capability}`,
      capability,
      custodyClass: options.custodyClass ?? 'non_custodial',
      version: '1.0.0',
    },
    async preflight() {
      return { ok: true, problems: [] };
    },
    async submit(context, payload) {
      const existing = byKey.get(context.idempotencyKey);
      if (existing && behaviour !== 'not_idempotent') {
        return result(existing);
      }
      if (behaviour === 'hang') {
        // Reaches the provider, then never answers.
        performed += 1;
        byKey.set(context.idempotencyKey, {
          operationRef: `op-${performed}`,
          observation: await honestObservation(capability, payload, 'honest'),
          completed: true,
        });
        return new Promise<never>(() => undefined);
      }
      performed += 1;
      const operation: Operation = {
        operationRef: `op-${performed}`,
        observation: await honestObservation(capability, payload, behaviour),
        completed: behaviour !== 'pending',
      };
      byKey.set(context.idempotencyKey, operation);
      if (behaviour === 'throw_on_submit') {
        throw new Error('provider connection reset');
      }
      return result(operation);
    },
    async status(query) {
      const operation = byKey.get(query.idempotencyKey);
      if (!operation) {
        return { outcome: 'not_found', operationRef: null };
      }
      return result(operation);
    },
  };

  return {
    adapter: options.unguarded ? raw : guardExecutionAdapter(raw),
    operations: () => performed,
    complete(idempotencyKey) {
      const operation = byKey.get(idempotencyKey);
      if (operation) {
        operation.completed = true;
      }
    },
    setBehaviour(next) {
      behaviour = next;
    },
  };
}

import { Interface, Wallet } from 'ethers';
import {
  AgroasysEscrow__factory,
  buildManagedSignerIntentHash,
  type ManagedSignerTransactionIntent,
} from '@agroasys/sdk';
import type { RelayerConfig } from '../src/config';
import type { RelayerSigningRequest } from '../src/signingPolicy';

export const relayerWallet = new Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
export const escrowAddress = '0x1000000000000000000000000000000000000001';
export const usdcAddress = '0x2000000000000000000000000000000000000002';

export const config: RelayerConfig = {
  port: 3300,
  nodeEnv: 'test',
  chainId: 84532,
  escrowAddress,
  usdcAddress,
  kmsKeyId: 'alias/cotsel-staging-relayer-signer',
  kmsExpectedAddress: relayerWallet.address,
  apiKeysJson: JSON.stringify({ id: 'gateway', secret: 'test-secret', active: true }),
  authMaxSkewSeconds: 300,
  authNonceTtlSeconds: 600,
  requestReplayTtlSeconds: 900,
  maxGasLimit: 1_500_000n,
  maxFeePerGasWei: 50_000_000_000n,
  maxNativeCostWei: 100_000_000_000_000_000n,
};

export function buildSigningRequest(
  overrides: Partial<RelayerSigningRequest> = {},
): RelayerSigningRequest {
  const data = new Interface(AgroasysEscrow__factory.abi).encodeFunctionData(
    'finalizeAfterDisputeWindow',
    [1n],
  );
  const requestId = overrides.requestId ?? 'signing-request-1';
  const signerAddress = overrides.signerAddress ?? relayerWallet.address;
  const transaction = overrides.transaction ?? {
    chainId: config.chainId,
    to: config.escrowAddress,
    data,
    value: '0',
    nonce: 7,
    gasLimit: '210000',
    type: 2 as const,
    maxFeePerGasWei: '1000000000',
    maxPriorityFeePerGasWei: '100000000',
  };
  const intent: ManagedSignerTransactionIntent = {
    requestId,
    signerAddress,
    ...transaction,
  };
  return {
    custodyMode: 'kms',
    operation: 'finalize_after_dispute_window',
    requestId,
    signerAddress,
    intentHash: buildManagedSignerIntentHash(intent),
    transaction,
    ...overrides,
  };
}

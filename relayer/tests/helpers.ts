import { Interface, TypedDataEncoder, Wallet } from 'ethers';
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
export const supplierWallet = new Wallet(
  '0x8b3a350cf5c34c9194ca3a545d3b43a1d388a9f4a1e86b3a9a9e7b60f7662a26',
);
export const escrowAddress = '0x1000000000000000000000000000000000000001';
export const usdcAddress = '0x2000000000000000000000000000000000000002';
export const serviceAuthSecret = 'test-secret-at-least-thirty-two-bytes';

export const config: RelayerConfig = {
  port: 3300,
  nodeEnv: 'test',
  chainId: 84532,
  escrowAddress,
  usdcAddress,
  kmsKeyId: 'alias/cotsel-staging-relayer-signer',
  kmsExpectedAddress: relayerWallet.address,
  apiKeysJson: JSON.stringify({ id: 'gateway', secret: serviceAuthSecret, active: true }),
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
  const tradeId = 1n;
  const authorizationNonce = 0n;
  const authorizationDeadline = 4_102_444_800n;
  const digest = TypedDataEncoder.hash(
    {
      name: 'AgroasysEscrow',
      version: '1',
      chainId: config.chainId,
      verifyingContract: config.escrowAddress,
    },
    {
      UserActionAuthorization: [
        { name: 'user', type: 'address' },
        { name: 'action', type: 'uint8' },
        { name: 'tradeId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    {
      user: supplierWallet.address,
      action: 4,
      tradeId,
      nonce: authorizationNonce,
      deadline: authorizationDeadline,
    },
  );
  const signature = supplierWallet.signingKey.sign(digest).serialized;
  const data = new Interface(AgroasysEscrow__factory.abi).encodeFunctionData(
    'finalizeAfterDisputeWindowWithAuthorization',
    [tradeId, authorizationNonce, authorizationDeadline, signature],
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
    policyContext: {
      kind: 'user_action',
      resourceId: 'handoff-1',
      actorAddress: supplierWallet.address,
      tradeId: tradeId.toString(),
      authorizationNonce: authorizationNonce.toString(),
      authorizationDeadline: authorizationDeadline.toString(),
    },
    ...overrides,
  };
}

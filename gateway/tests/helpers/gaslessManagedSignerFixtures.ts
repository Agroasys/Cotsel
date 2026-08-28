/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { keccak256, Wallet } from 'ethers';
import type { FeeData, TransactionRequest, TransactionResponse } from 'ethers';
import type { GatewayConfig } from '../../src/config/env';
import {
  type GaslessCreateTradeExecutionInput,
  type GaslessUserAction,
  type GaslessUserActionExecutionInput,
  testExports as gaslessSettlementExecutionTestExports,
} from '../../src/core/gaslessSettlementExecutionService';

export const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:4100',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: ['http://127.0.0.1:8546'],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000999',
  usdcAddress: '0x0000000000000000000000000000000000000888',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: true,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  gaslessExecutionEnabled: true,
  gaslessRequestMaxTtlSeconds: 900,
  commitSha: 'test',
  buildTime: '2026-03-11T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: false,
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

export function buildCreateTradeInput(
  handoffId: string,
  label: string,
): GaslessCreateTradeExecutionInput {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const buyerAddress = '0x0000000000000000000000000000000000000200';
  const payload = {
    action: 'create_trade' as const,
    handoffId,
    chainId: config.chainId,
    contractAddress: config.escrowAddress,
    expiresAt,
    buyerAddress,
    supplierAddress: '0x0000000000000000000000000000000000000100',
    totalAmount: '1000000000',
    logisticsAmount: '100000000',
    platformFeesAmount: '10000000',
    supplierFirstTranche: '445000000',
    supplierSecondTranche: '445000000',
    ricardianHash: `0x${label.slice(0, 1).repeat(64)}`,
    buyerAuthorization: {
      nonce: '0',
      deadline: authorizationDeadline.toString(),
      signature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    usdcAuthorization: {
      from: buyerAddress,
      to: config.escrowAddress,
      value: '1000000000',
      validAfter: '0',
      validBefore: authorizationDeadline.toString(),
      nonce: `0x${label.slice(0, 1).repeat(64)}`,
      v: 27,
      r: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      s: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
  };

  return {
    ...payload,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(payload),
    requestId: `gasless-${label}`,
  };
}

export function buildUserActionInput(
  action: GaslessUserAction,
  label: string,
): GaslessUserActionExecutionInput {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const payload = {
    action,
    handoffId: `handoff-${label}`,
    chainId: config.chainId,
    contractAddress: config.escrowAddress,
    expiresAt,
    userAddress: '0x0000000000000000000000000000000000000200',
    tradeId: '17',
    userAuthorization: {
      nonce: '0',
      deadline: authorizationDeadline.toString(),
      signature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };

  return {
    ...payload,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(payload),
    requestId: `gasless-${label}`,
  };
}

export interface FakeManagedSignerTransaction {
  chainId: number;
  to: string;
  data: string;
  value: string;
  nonce: number;
  gasLimit: string;
  type: 0 | 2;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  gasPriceWei?: string;
}

export interface FakeManagedSignerRequest {
  requestId: string;
  intentHash: string;
  operation: string;
  signerAddress: string;
  transaction: FakeManagedSignerTransaction;
}

export interface FakeManagedSignerResponse {
  requestId: unknown;
  intentHash: unknown;
  signerAddress: unknown;
  signedTransaction: unknown;
}

export const managedSignerWallet = new Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

export function createFakeManagedSignerDependencies(options?: {
  balanceWei?: bigint;
  broadcastFailures?: Error[];
  maxFeePerGasWei?: bigint;
  nonceStart?: number;
  receiptAvailable?: boolean;
  mutateSignerTransaction?: (
    transaction: FakeManagedSignerTransaction,
  ) => FakeManagedSignerTransaction;
  mutateSignerResponse?: (response: FakeManagedSignerResponse) => FakeManagedSignerResponse;
}) {
  const balanceWei = options?.balanceWei ?? 100n;
  const broadcastFailures = [...(options?.broadcastFailures ?? [])];
  const maxFeePerGasWei = options?.maxFeePerGasWei ?? 1n;
  const receiptAvailable = options?.receiptAvailable ?? true;
  let nextNonce = options?.nonceStart ?? 7;
  const recordValidationEvidence = jest.fn();
  const recordTransactionOutcome = {
    recordPrepared: jest.fn(async () => undefined),
    markBroadcastUnknown: jest.fn(async () => undefined),
    markConfirmationPending: jest.fn(async () => undefined),
    markConfirmed: jest.fn(async () => undefined),
    markReverted: jest.fn(async () => undefined),
  };

  return {
    provider: {
      call: jest.fn(async (_transaction: TransactionRequest) => '0x'),
      estimateGas: jest.fn(async (_transaction: TransactionRequest) => 210000n),
      getBalance: jest.fn(async (_address: string) => balanceWei),
      getFeeData: jest.fn(
        async () =>
          ({
            maxFeePerGas: maxFeePerGasWei,
            maxPriorityFeePerGas: 1n,
            gasPrice: null,
          }) as unknown as FeeData,
      ),
      getTransactionCount: jest.fn(async (_address: string, _blockTag?: 'pending') => {
        const nonce = nextNonce;
        nextNonce += 1;
        return nonce;
      }),
      broadcastTransaction: jest.fn(async (_signedTransaction: string) => {
        const failure = broadcastFailures.shift();
        if (failure) {
          throw failure;
        }
        return {
          hash: keccak256(_signedTransaction),
          wait: async () =>
            receiptAvailable
              ? {
                  status: 1,
                  blockNumber: 98765,
                  blockHash: '0x8888888888888888888888888888888888888888888888888888888888888888',
                  gasUsed: 210000n,
                  gasPrice: 1n,
                }
              : null,
        } as unknown as TransactionResponse;
      }),
    },
    signerTransport: {
      getSignerAddress: jest.fn(async () => managedSignerWallet.address),
      signTransaction: jest.fn(async (request: FakeManagedSignerRequest) => {
        const transaction = options?.mutateSignerTransaction
          ? options.mutateSignerTransaction(request.transaction)
          : request.transaction;
        const signedTransaction = await managedSignerWallet.signTransaction({
          chainId: transaction.chainId,
          to: transaction.to,
          data: transaction.data,
          value: BigInt(transaction.value),
          nonce: transaction.nonce,
          gasLimit: BigInt(transaction.gasLimit),
          type: transaction.type,
          ...(transaction.type === 2
            ? {
                maxFeePerGas: BigInt(transaction.maxFeePerGasWei!),
                maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGasWei!),
              }
            : { gasPrice: BigInt(transaction.gasPriceWei!) }),
        });
        const signerResponse: FakeManagedSignerResponse = {
          requestId: request.requestId,
          intentHash: request.intentHash,
          signerAddress: managedSignerWallet.address,
          signedTransaction,
        };
        return options?.mutateSignerResponse
          ? options.mutateSignerResponse(signerResponse)
          : signerResponse;
      }),
    },
    recordValidationEvidence,
    recordTransactionOutcome,
  };
}

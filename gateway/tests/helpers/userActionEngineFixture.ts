import {
  verifyNonceOwnership,
  type VerifyUserActionRetirement,
} from '../../src/core/userActionEngine/retirement';
/** SPDX-License-Identifier: Apache-2.0 */
import {
  Wallet,
  Transaction,
  FeeData,
  type TransactionReceipt,
  type TransactionResponse,
  type TransactionRequest,
} from 'ethers';
import type { Pool } from 'pg';
import { createBoundUserActionFixture } from './boundUserActionFixture';
import { createGaslessPayloadHash } from '../../src/core/gaslessRequestNormalization';
import { createPostgresSettlementStore } from '../../src/core/settlementStore';
import { SettlementService } from '../../src/core/settlementService';
import { config } from './gaslessManagedSignerFixtures';
import { createUserActionRequestStore } from '../../src/core/userActionEngine/requestStore';
import { createPostgresGaslessNonceReservationStore } from '../../src/core/gaslessNonceReservationStore';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../../src/core/gaslessTransactionOutcomeStore';
import type { DormantUserActionEnginePorts } from '../../src/core/userActionEngine/workflow';
import type { GaslessUserAction } from '../../src/core/gaslessExecutionTypes';
export async function userActionEngineFixture(
  pool: Pool,
  action: GaslessUserAction = 'finalize_after_inspection_acceptance',
  mode: 'raw' | 'kms' = 'raw',
  label = 'one',
  deadline = '2000000000',
  operation = `operation-${label}`,
) {
  const fixture = await createBoundUserActionFixture(action, deadline);
  fixture.input.handoffId = `handoff-${label}`;
  fixture.input.actionPackageId = fixture.binding.packageId = `package-${label}`;
  fixture.input.sourceOperationId = fixture.binding.sourceOperationId = operation;
  // package/operation form part of signed execution scope but not original EIP712 auth.
  const { createUserActionExecutionScopeHash } =
    await import('../../src/core/settlementUserActionBinding');
  fixture.binding.executionScopeHash = createUserActionExecutionScopeHash(fixture.input);
  const store = createPostgresSettlementStore(pool);
  const service = new SettlementService({ ...config, settlementCallbackEnabled: false }, store);
  const handoff = await service.createHandoff({
    platformId: 'agroasys',
    platformHandoffId: fixture.input.handoffId,
    tradeId: '7',
    phase: 'gasless_user_action',
    settlementChannel: 'cotsel_escrow',
    displayCurrency: 'USD',
    displayAmount: '1.00',
    assetSymbol: 'USDC',
    assetAmount: '1000',
    externalReference: fixture.input.sourceOperationId,
    executionBinding: fixture.binding,
    requestId: 'initial',
    sourceApiKeyId: 'owner',
  });
  fixture.input.handoffId = handoff.handoffId;
  const {
    payloadHash: _hash,
    requestId: _request,
    sourceApiKeyId: _owner,
    ...payload
  } = fixture.input;
  fixture.input.payloadHash = createGaslessPayloadHash(payload);
  const wallet = new Wallet('0x' + '77'.repeat(32));
  const sign = jest.fn((tx: TransactionRequest) => wallet.signTransaction(tx));
  let now = Number(fixture.input.userAuthorization.deadline) * 1000 - 300_000;
  const funding = jest.fn(async () => {});
  const finality = {
    verifyReceipt: jest.fn(async (chain: number, hash: string, receipt: TransactionReceipt) => ({
      policyVersion: 'gasless_dual_rpc_finalized_v1' as const,
      chainId: String(chain),
      transactionHash: hash,
      blockNumber: String(receipt.blockNumber),
      blockHash: receipt.blockHash,
      finalizedBlockNumber: '200',
      finalizedBlockHash: '0x' + 'f'.repeat(64),
      rpcWitnesses: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)],
    })),
    revalidateBlock: jest.fn(async () => 'canonical' as const),
  };
  const provider = {
    call: jest.fn(async () => '0x'),
    estimateGas: jest.fn(async () => 100_000n),
    getBalance: jest.fn(async () => 1_000_000n),
    getFeeData: jest.fn(async () => new FeeData(null, 2n, 1n)),
    getTransactionCount: jest.fn(async () => 7),
    broadcastTransaction: jest.fn(async (bytes: string) => {
      const tx = Transaction.from(bytes);
      const receipt = {
        hash: tx.hash!,
        to: fixture.input.contractAddress,
        status: 1,
        blockNumber: 101,
        blockHash: '0x' + 'a'.repeat(64),
        gasUsed: 90_000n,
        gasPrice: 2n,
      } as TransactionReceipt;
      return { hash: tx.hash!, wait: async () => receipt } as unknown as TransactionResponse;
    }),
  };
  const transport = {
    getSignerAddress: jest.fn(async () => wallet.address),
    signTransaction: jest.fn(
      async (request: import('../../src/core/managedSignerTransport').ManagedSignerRequest) => {
        const tx = request.transaction;
        const signed = await sign({
          chainId: tx.chainId,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          type: tx.type,
          ...(tx.type === 2
            ? { maxFeePerGas: tx.maxFeePerGasWei, maxPriorityFeePerGas: tx.maxPriorityFeePerGasWei }
            : { gasPrice: tx.gasPriceWei }),
        });
        return {
          requestId: request.requestId,
          intentHash: request.intentHash,
          signerAddress: wallet.address,
          signedTransaction: signed,
        };
      },
    ),
  };
  const requests = createUserActionRequestStore(pool, 60, () => now);
  const retirement: VerifyUserActionRetirement = jest.fn(
    async () => ({ status: 'unavailable' }) as const,
  );
  const ports: DormantUserActionEnginePorts = {
    chainId: fixture.input.chainId,
    escrowAddress: fixture.input.contractAddress,
    usdcAddress: fixture.token,
    requestMaxTtlSeconds: 900,
    now: () => new Date(now),
    loadHandoff: (id) => store.getHandoff(id),
    verifyFunding: funding,
    verifyNonceOwnership: (input) => verifyNonceOwnership(pool, input, retirement),
    requests,
    settlementService: service,
    assertBroadcastOpen: jest.fn(),
    assertCapacityOpen: jest.fn(),
    custody: {
      chainId: fixture.input.chainId,
      escrowAddress: fixture.input.contractAddress,
      usdcAddress: fixture.token,
      provider,
      nonces: createPostgresGaslessNonceReservationStore(pool),
      outcomes: createPostgresGaslessTransactionOutcomeRecorder(pool),
      finality,
      maxGasLimit: 200_000n,
      maxFeePerGasWei: 10n,
      maxNativeCostWei: 1_000_000n,
      minBalanceWei: 100n,
      receiptTimeoutMs: 100,
      signer:
        mode === 'raw'
          ? {
              mode: 'raw',
              wallet: { getAddress: async () => wallet.address, signTransaction: sign },
            }
          : { mode: 'kms', transport },
    },
  };
  return {
    ...fixture,
    handoff,
    store,
    service,
    ports,
    requests,
    provider,
    sign,
    transport,
    funding,
    finality,
    retirement,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

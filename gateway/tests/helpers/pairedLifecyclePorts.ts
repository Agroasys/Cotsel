/** SPDX-License-Identifier: Apache-2.0 */
// Controlled ports only: local fixture signatures, no network or chain submission.
import {
  FeeData,
  JsonRpcProvider,
  Transaction,
  Wallet,
  type Block,
  type Network,
  type TransactionReceipt,
  type TransactionRequest,
} from 'ethers';
import type { Pool } from 'pg';
import {
  verifyUserActionFunding,
  type UserActionFundingWitness,
} from '../../src/core/userActionFundingVerification';
import { createPostgresGaslessNonceReservationStore } from '../../src/core/gaslessNonceReservationStore';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../../src/core/gaslessTransactionOutcomeStore';
import type { UserActionCustodyPorts } from '../../src/core/userActionEngine/custody';
import type { PairedStart } from './pairedLifecycleProtocol';

export function pairedLifecyclePorts(
  seed: PairedStart,
  pool: Pool,
  pauseSigning: () => Promise<void>,
) {
  const binding = seed.executionBinding;
  let signerInvocations = 0,
    broadcastCalls = 0,
    fundingReads = 0;
  const local = seed.localRpcUrls?.map(
    (url) => new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }),
  );
  const witnesses: UserActionFundingWitness[] =
    local ??
    seed.fundingWitnesses.map((value) => ({
      getNetwork: async () => {
        fundingReads++;
        return { chainId: BigInt(value.chainId) } as Network;
      },
      getTransactionReceipt: async (hash: string) => {
        fundingReads++;
        return hash.toLowerCase() === value.receipt.hash
          ? (structuredClone(value.receipt) as unknown as TransactionReceipt)
          : null;
      },
      getBlock: async (height) => {
        fundingReads++;
        const number = height === 'finalized' ? value.finalizedBlockNumber : Number(height);
        return structuredClone(
          value.blocks.find((block) => block.number === number) ?? null,
        ) as Block | null;
      },
    }));
  const wallet = new Wallet('0x' + '77'.repeat(32));
  const sign = async (tx: TransactionRequest) => {
    await pauseSigning();
    signerInvocations++;
    return wallet.signTransaction(tx);
  };
  const custody: UserActionCustodyPorts = {
    chainId: Number(binding.chainId),
    escrowAddress: binding.escrowAddress,
    usdcAddress: binding.tokenAddress,
    provider: {
      call: async (tx) => (local ? local[0]!.call(tx) : '0x'),
      estimateGas: async (tx) => (local ? local[0]!.estimateGas(tx) : 100_000n),
      getBalance: async () => 10n ** 18n,
      getFeeData: async () => new FeeData(null, 2n, 1n),
      getTransactionCount: async (address, tag) =>
        local ? local[0]!.getTransactionCount(address, tag) : 7,
      broadcastTransaction: async (signed) => {
        broadcastCalls++;
        if (local) {
          const results = await Promise.all(
            local.map((provider) => provider.broadcastTransaction(signed)),
          );
          await Promise.all(results.map((result) => result.wait()));
          return results[0]!;
        }
        // Local port retains the real signed identity; no network submission occurs.
        return { hash: Transaction.from(signed).hash!, wait: async () => null } as never;
      },
    },
    nonces: createPostgresGaslessNonceReservationStore(pool),
    outcomes: createPostgresGaslessTransactionOutcomeRecorder(pool, 'user_action'),
    finality: { verifyReceipt: async () => null, revalidateBlock: async () => 'unavailable' },
    maxGasLimit: 200_000n,
    maxFeePerGasWei: 10n,
    maxNativeCostWei: 1_000_000n,
    minBalanceWei: 100n,
    receiptTimeoutMs: 100,
    signer:
      seed.custodyMode === 'raw'
        ? {
            mode: 'raw',
            wallet: { getAddress: async () => wallet.address, signTransaction: sign },
          }
        : {
            mode: 'kms',
            transport: {
              getSignerAddress: async () => wallet.address,
              signTransaction: async (request) => {
                const tx = request.transaction;
                return {
                  requestId: request.requestId,
                  intentHash: request.intentHash,
                  signerAddress: wallet.address,
                  signedTransaction: await sign({
                    chainId: tx.chainId,
                    to: tx.to,
                    data: tx.data,
                    value: tx.value,
                    nonce: tx.nonce,
                    gasLimit: tx.gasLimit,
                    type: tx.type,
                    ...(tx.type === 2
                      ? {
                          maxFeePerGas: tx.maxFeePerGasWei,
                          maxPriorityFeePerGas: tx.maxPriorityFeePerGasWei,
                        }
                      : { gasPrice: tx.gasPriceWei }),
                  }),
                };
              },
            },
          },
  };
  return {
    custody,
    verifyFunding: (value: typeof binding) =>
      verifyUserActionFunding(
        {
          chainId: Number(binding.chainId),
          escrowAddress: binding.escrowAddress,
          usdcAddress: binding.tokenAddress,
        },
        witnesses,
        value,
      ),
    close: () => local?.forEach((provider) => provider.destroy()),
    counters: () => ({ signerInvocations, broadcastCalls, fundingReads }),
  };
}

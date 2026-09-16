/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress, keccak256, toUtf8Bytes } from 'ethers';
import type { FeeData, Provider, TransactionRequest, TransactionResponse } from 'ethers';
import { buildManagedSignerIntentHash } from '@agroasys/sdk';
import type { ManagedSignerPolicyContext, ManagedSignerTransactionIntent } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { GatewayError } from '../errors';
import type { GaslessExecutionReceipt, GaslessSettlementExecutor } from './gaslessExecutionTypes';
import {
  broadcastPersistedGaslessTransaction,
  GaslessTransactionOutcomePendingError,
  GaslessTransactionRevertedError,
  persistGaslessTerminalOutcome,
} from './gaslessTransactionLifecycle';
import type { GaslessTransactionOutcomeRecorder } from './gaslessTransactionOutcomeStore';
import type { GaslessNonceReservationStore } from './gaslessNonceReservationStore';
import {
  buildManagedCreateTradeTransaction,
  buildManagedUserActionTransaction,
  buildManagedWalletTransferTransaction,
  createTradePolicyContext,
  userActionPolicyContext,
  walletTransferPolicyContext,
} from './gaslessManagedSignerTransactions';
import {
  serializeManagedSignerTransaction,
  validateManagedSignerForBroadcast,
} from './managedSignerIntentValidation';
import type { ManagedSignerValidationRecorder } from './managedSignerIntentValidation';
import { createManagedSignerTransport } from './managedSignerTransport';
import type {
  ManagedSignerGaslessConfig,
  ManagedSignerRequest,
  ManagedSignerTransport,
} from './managedSignerTransport';

interface GaslessManagedProvider {
  call(transaction: TransactionRequest): Promise<string>;
  estimateGas(transaction: TransactionRequest): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
  getFeeData(): Promise<FeeData>;
  getTransactionCount(address: string, blockTag?: 'pending'): Promise<number>;
  broadcastTransaction(signedTransaction: string): Promise<TransactionResponse>;
}

function buildSigningRequestId(input: {
  applicationRequestId: string;
  chainId: number;
  operation: ManagedSignerRequest['operation'];
  resourceId: string;
  resourceType: 'settlement_handoff' | 'platform_transfer';
  signerAddress: string;
  transactionNonce: number;
}): string {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify([
        input.applicationRequestId,
        input.chainId,
        input.operation,
        input.resourceId,
        input.resourceType,
        getAddress(input.signerAddress).toLowerCase(),
        input.transactionNonce,
      ]),
    ),
  );
}

export function createManagedSignerGaslessSettlementExecutor(
  config: ManagedSignerGaslessConfig,
  dependencies?: {
    provider?: GaslessManagedProvider;
    signerTransport?: ManagedSignerTransport;
    recordValidationEvidence?: ManagedSignerValidationRecorder;
    recordTransactionOutcome: GaslessTransactionOutcomeRecorder;
    nonceReservationStore: GaslessNonceReservationStore;
  },
): GaslessSettlementExecutor {
  const configuredCustodyMode = config.gaslessSignerCustodyMode;
  if (configuredCustodyMode !== 'kms' && configuredCustodyMode !== 'mpc') {
    throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gasless managed signer mode is invalid');
  }
  const custodyMode: 'kms' | 'mpc' = configuredCustodyMode;

  const provider =
    dependencies?.provider ??
    (createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
      chainId: config.chainId,
      quorum: config.rpcQuorum,
    }) as Provider as GaslessManagedProvider);
  const signerTransport = dependencies?.signerTransport ?? createManagedSignerTransport(config);
  if (!dependencies?.recordTransactionOutcome) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless transaction outcome persistence is not configured',
    );
  }
  const transactionOutcomeRecorder = dependencies.recordTransactionOutcome;
  if (!dependencies.nonceReservationStore) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless durable nonce reservation is not configured',
    );
  }
  const nonceReservationStore = dependencies.nonceReservationStore;
  const transactionConfig = {
    chainId: config.chainId,
    escrowAddress: config.escrowAddress,
    usdcAddress: config.usdcAddress,
  };
  const gaslessMaxGasLimit = config.gaslessMaxGasLimit ?? 1_500_000n;
  const gaslessMaxFeePerGasWei = config.gaslessMaxFeePerGasWei ?? 50_000_000_000n;
  const gaslessMaxNativeCostWei = config.gaslessMaxNativeCostWei ?? 100_000_000_000_000_000n;
  const gaslessMinExecutorBalanceWei = config.gaslessMinExecutorBalanceWei ?? 0n;
  const gaslessReceiptTimeoutMs = config.gaslessReceiptTimeoutMs ?? 120_000;

  async function resolveExecutorAddress(): Promise<string> {
    const signerAddress = await signerTransport.getSignerAddress();
    if (!isAddress(signerAddress)) {
      throw new GatewayError(
        502,
        'UPSTREAM_UNAVAILABLE',
        'Gasless managed signer returned an invalid address',
      );
    }
    return getAddress(signerAddress);
  }

  let executorAddressPromise: Promise<string> | null = null;
  function getExecutorAddress(): Promise<string> {
    executorAddressPromise ??= resolveExecutorAddress();
    return executorAddressPromise;
  }

  async function assertSignerBalance(): Promise<{ executorAddress: string; balance: bigint }> {
    const executorAddress = await getExecutorAddress();
    const balance = await provider.getBalance(executorAddress);
    if (balance < gaslessMinExecutorBalanceWei) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Gasless executor balance is below floor',
        {
          balanceWei: balance.toString(),
          minBalanceWei: gaslessMinExecutorBalanceWei.toString(),
        },
      );
    }

    return { executorAddress, balance };
  }

  async function assertGasSpendCap(gasEstimate: bigint): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  }> {
    const feeData = await provider.getFeeData();
    const effectiveFeePerGasWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!effectiveFeePerGasWei) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Gasless relayer could not resolve chain fee data',
      );
    }

    if (effectiveFeePerGasWei > gaslessMaxFeePerGasWei) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Gasless relayer fee-per-gas cap exceeded',
        {
          feePerGasWei: effectiveFeePerGasWei.toString(),
          maxFeePerGasWei: gaslessMaxFeePerGasWei.toString(),
        },
      );
    }

    const estimatedNativeCostWei = gasEstimate * effectiveFeePerGasWei;
    if (estimatedNativeCostWei > gaslessMaxNativeCostWei) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Gasless relayer native spend cap exceeded',
        {
          estimatedNativeCostWei: estimatedNativeCostWei.toString(),
          maxNativeCostWei: gaslessMaxNativeCostWei.toString(),
        },
      );
    }

    if (feeData.maxFeePerGas) {
      return {
        maxFeePerGas: feeData.maxFeePerGas,
        ...(feeData.maxPriorityFeePerGas
          ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
          : {}),
      };
    }

    return { gasPrice: effectiveFeePerGasWei };
  }

  async function simulateTransaction(transaction: TransactionRequest): Promise<bigint> {
    await provider.call(transaction);
    const gasEstimate = await provider.estimateGas(transaction);
    if (gasEstimate > gaslessMaxGasLimit) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'Gasless transaction gas estimate exceeds cap',
        {
          gasEstimate: gasEstimate.toString(),
          gasCap: gaslessMaxGasLimit.toString(),
        },
      );
    }
    return gasEstimate;
  }

  async function waitForConfirmedReceipt(
    tx: TransactionResponse,
  ): Promise<GaslessExecutionReceipt> {
    let receipt;
    try {
      receipt = await tx.wait(1, gaslessReceiptTimeoutMs);
    } catch {
      throw new GaslessTransactionOutcomePendingError(
        tx.hash,
        'confirmation_pending',
        'Gasless transaction confirmation requires reconciliation',
      );
    }
    if (!receipt) {
      throw new GaslessTransactionOutcomePendingError(
        tx.hash,
        'confirmation_pending',
        'Gasless transaction confirmation requires reconciliation',
      );
    }
    const outcome = {
      blockNumber: BigInt(receipt.blockNumber).toString(),
      blockHash: receipt.blockHash,
      gasUsed: BigInt(receipt.gasUsed ?? 0n).toString(),
      effectiveGasPriceWei: BigInt(receipt.gasPrice ?? 0n).toString(),
    };
    if (receipt.status !== 1) {
      await persistGaslessTerminalOutcome(transactionOutcomeRecorder, tx.hash, 'reverted', outcome);
      throw new GaslessTransactionRevertedError(tx.hash, outcome.blockNumber);
    }

    const { executorAddress } = await assertSignerBalance();
    const executorBalance = await provider.getBalance(executorAddress);
    const gasUsed = BigInt(receipt.gasUsed ?? 0n);
    const effectiveGasPriceWei = BigInt(receipt.gasPrice ?? 0n);
    await persistGaslessTerminalOutcome(transactionOutcomeRecorder, tx.hash, 'confirmed', outcome);

    return {
      txHash: tx.hash,
      blockNumber: BigInt(receipt.blockNumber).toString(),
      gasUsed: gasUsed.toString(),
      effectiveGasPriceWei: effectiveGasPriceWei.toString(),
      nativeCostWei: (gasUsed * effectiveGasPriceWei).toString(),
      executorAddress,
      executorBalanceWei: executorBalance.toString(),
    };
  }

  async function broadcastManagedTransaction(
    operation: ManagedSignerRequest['operation'],
    policyContext: ManagedSignerPolicyContext,
    context: {
      applicationRequestId: string;
      resourceType: 'settlement_handoff' | 'platform_transfer';
      resourceId: string;
    },
    transaction: TransactionRequest,
    gasEstimate: bigint,
    feeOverrides: {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    },
  ): Promise<TransactionResponse> {
    const executorAddress = await getExecutorAddress();
    const nonce = await provider.getTransactionCount(executorAddress, 'pending');
    const requestTransaction = {
      ...transaction,
      ...feeOverrides,
      gasLimit: gasEstimate,
      nonce,
    };
    const requestId = buildSigningRequestId({
      applicationRequestId: context.applicationRequestId,
      chainId: config.chainId,
      operation,
      resourceId: context.resourceId,
      resourceType: context.resourceType,
      signerAddress: executorAddress,
      transactionNonce: nonce,
    });
    const serializedTransaction = serializeManagedSignerTransaction(requestTransaction);
    const intent: ManagedSignerTransactionIntent = {
      requestId,
      signerAddress: executorAddress,
      ...serializedTransaction,
    };
    const intentHash = buildManagedSignerIntentHash(intent);
    const nonceReservation = await nonceReservationStore.reserve({
      chainId: config.chainId,
      signerAddress: executorAddress,
      transactionNonce: nonce,
      requestId,
      applicationRequestId: context.applicationRequestId,
      resourceType: context.resourceType,
      resourceId: context.resourceId,
      operation,
      intentHash,
    });
    await nonceReservationStore.beginSigning(nonceReservation);
    const signerResponse = await signerTransport.signTransaction({
      custodyMode,
      operation,
      signerAddress: executorAddress,
      requestId,
      intentHash,
      transaction: serializedTransaction,
      policyContext,
    });
    const signedTransaction = await validateManagedSignerForBroadcast(
      signerResponse,
      intent,
      { operation, ...context },
      dependencies?.recordValidationEvidence,
    );
    await nonceReservationStore.recordSigned(nonceReservation, keccak256(signedTransaction));
    return broadcastPersistedGaslessTransaction(
      signedTransaction,
      {
        ...context,
        operation,
        intentHash,
      },
      transactionOutcomeRecorder,
      (signed) => provider.broadcastTransaction(signed),
    );
  }

  return {
    async simulateCreateTrade(input) {
      const { executorAddress } = await assertSignerBalance();
      return {
        gasEstimate: await simulateTransaction(
          buildManagedCreateTradeTransaction(transactionConfig, input, executorAddress),
        ),
      };
    },

    async executeCreateTrade(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildManagedCreateTradeTransaction(
        transactionConfig,
        input,
        executorAddress,
      );
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        'create_trade',
        createTradePolicyContext(input),
        {
          applicationRequestId: input.requestId,
          resourceType: 'settlement_handoff',
          resourceId: input.handoffId,
        },
        transaction,
        gasEstimate,
        feeOverrides,
      );
      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },

    async simulateUserAction(input) {
      const { executorAddress } = await assertSignerBalance();
      return {
        gasEstimate: await simulateTransaction(
          buildManagedUserActionTransaction(transactionConfig, input, executorAddress),
        ),
      };
    },

    async executeUserAction(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildManagedUserActionTransaction(
        transactionConfig,
        input,
        executorAddress,
      );
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        input.action,
        userActionPolicyContext(input),
        {
          applicationRequestId: input.requestId,
          resourceType: 'settlement_handoff',
          resourceId: input.handoffId,
        },
        transaction,
        gasEstimate,
        feeOverrides,
      );
      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },

    async simulateWalletUsdcTransfer(input) {
      const { executorAddress } = await assertSignerBalance();
      return {
        gasEstimate: await simulateTransaction(
          buildManagedWalletTransferTransaction(transactionConfig, input, executorAddress),
        ),
      };
    },

    async executeWalletUsdcTransfer(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildManagedWalletTransferTransaction(
        transactionConfig,
        input,
        executorAddress,
      );
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        'wallet_usdc_transfer',
        walletTransferPolicyContext(input),
        {
          applicationRequestId: input.requestId,
          resourceType: 'platform_transfer',
          resourceId: input.platformTransferId,
        },
        transaction,
        gasEstimate,
        feeOverrides,
      );
      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },
  };
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { getAddress, Interface, isAddress } from 'ethers';
import type { FeeData, Provider, TransactionRequest, TransactionResponse } from 'ethers';
import { AgroasysEscrow__factory, buildManagedSignerIntentHash } from '@agroasys/sdk';
import type { ManagedSignerTransactionIntent } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { GatewayError } from '../errors';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessExecutionReceipt,
  GaslessOperatorActionExecutionInput,
  GaslessSettlementExecutor,
  GaslessUserActionExecutionInput,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import {
  broadcastPersistedGaslessTransaction,
  GaslessTransactionOutcomePendingError,
  GaslessTransactionRevertedError,
  persistGaslessTerminalOutcome,
} from './gaslessTransactionLifecycle';
import type { GaslessTransactionOutcomeRecorder } from './gaslessTransactionOutcomeStore';
import {
  logGaslessSigningCompleted,
  logGaslessSigningStarted,
} from './gaslessTransactionTelemetry';
import {
  buildCreateTradeArguments,
  buildUserActionArguments,
  buildWalletUsdcTransferArguments,
  getUserActionFunctionName,
  USDC_AUTHORIZATION_ABI,
} from './gaslessTransactionEncoding';
import {
  serializeManagedSignerTransaction,
  validateManagedSignerForBroadcast,
} from './managedSignerIntentValidation';
import type { ManagedSignerValidationRecorder } from './managedSignerIntentValidation';
import { createHttpManagedSignerTransport } from './managedSignerTransport';
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

export function createManagedSignerGaslessSettlementExecutor(
  config: ManagedSignerGaslessConfig,
  dependencies?: {
    provider?: GaslessManagedProvider;
    signerTransport?: ManagedSignerTransport;
    recordValidationEvidence?: ManagedSignerValidationRecorder;
    recordTransactionOutcome: GaslessTransactionOutcomeRecorder;
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
  const signerTransport = dependencies?.signerTransport ?? createHttpManagedSignerTransport(config);
  if (!dependencies?.recordTransactionOutcome) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless transaction outcome persistence is not configured',
    );
  }
  const transactionOutcomeRecorder = dependencies.recordTransactionOutcome;
  const escrowInterface = new Interface(AgroasysEscrow__factory.abi);
  const usdcInterface = new Interface(USDC_AUTHORIZATION_ABI);
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

  function buildCreateTradeTransaction(
    input: GaslessCreateTradeExecutionInput,
    from: string,
  ): TransactionRequest {
    return {
      from,
      to: config.escrowAddress,
      chainId: config.chainId,
      value: 0n,
      data: escrowInterface.encodeFunctionData(
        'createTradeWithAuthorization',
        buildCreateTradeArguments(input),
      ),
    };
  }

  function buildUserActionTransaction(
    input: GaslessUserActionExecutionInput,
    from: string,
  ): TransactionRequest {
    const args = buildUserActionArguments(input);
    const functionName = getUserActionFunctionName(input.action);

    return {
      from,
      to: config.escrowAddress,
      chainId: config.chainId,
      value: 0n,
      data: escrowInterface.encodeFunctionData(functionName, args),
    };
  }

  function buildOperatorActionTransaction(
    input: GaslessOperatorActionExecutionInput,
    from: string,
  ): TransactionRequest {
    return {
      from,
      to: config.escrowAddress,
      chainId: config.chainId,
      value: 0n,
      data: escrowInterface.encodeFunctionData('finalizeAfterDisputeWindow', [input.tradeId]),
    };
  }

  function buildWalletUsdcTransferTransaction(
    input: GaslessWalletUsdcTransferExecutionInput,
    from: string,
  ): TransactionRequest {
    return {
      from,
      to: config.usdcAddress,
      chainId: config.chainId,
      value: 0n,
      data: usdcInterface.encodeFunctionData(
        'transferWithAuthorization',
        buildWalletUsdcTransferArguments(input),
      ),
    };
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
    const requestId = randomUUID();
    const serializedTransaction = serializeManagedSignerTransaction(requestTransaction);
    const intent: ManagedSignerTransactionIntent = {
      requestId,
      signerAddress: executorAddress,
      ...serializedTransaction,
    };
    const intentHash = buildManagedSignerIntentHash(intent);
    const transactionContext = { ...context, operation };
    logGaslessSigningStarted(transactionContext, custodyMode);
    const signerResponse = await signerTransport.signTransaction({
      custodyMode,
      operation,
      signerAddress: executorAddress,
      requestId,
      intentHash,
      transaction: serializedTransaction,
    });
    logGaslessSigningCompleted(transactionContext, custodyMode);
    const signedTransaction = await validateManagedSignerForBroadcast(
      signerResponse,
      intent,
      { operation, ...context },
      dependencies?.recordValidationEvidence,
    );
    return broadcastPersistedGaslessTransaction(
      signedTransaction,
      { ...transactionContext, intentHash },
      transactionOutcomeRecorder,
      (signed) => provider.broadcastTransaction(signed),
    );
  }

  return {
    async simulateCreateTrade(input) {
      const { executorAddress } = await assertSignerBalance();
      return {
        gasEstimate: await simulateTransaction(buildCreateTradeTransaction(input, executorAddress)),
      };
    },

    async executeCreateTrade(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildCreateTradeTransaction(input, executorAddress);
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        'create_trade',
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
        gasEstimate: await simulateTransaction(buildUserActionTransaction(input, executorAddress)),
      };
    },

    async executeUserAction(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildUserActionTransaction(input, executorAddress);
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        input.action,
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

    async simulateOperatorAction(input) {
      const { executorAddress } = await assertSignerBalance();
      return {
        gasEstimate: await simulateTransaction(
          buildOperatorActionTransaction(input, executorAddress),
        ),
      };
    },

    async executeOperatorAction(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildOperatorActionTransaction(input, executorAddress);
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        input.action,
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
          buildWalletUsdcTransferTransaction(input, executorAddress),
        ),
      };
    },

    async executeWalletUsdcTransfer(input) {
      const { executorAddress } = await assertSignerBalance();
      const transaction = buildWalletUsdcTransferTransaction(input, executorAddress);
      const gasEstimate = await simulateTransaction(transaction);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await broadcastManagedTransaction(
        'wallet_usdc_transfer',
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

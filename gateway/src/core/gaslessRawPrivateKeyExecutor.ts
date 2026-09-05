/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Contract, Interface, TransactionReceipt, Wallet } from 'ethers';
import type { TransactionRequest, TransactionResponse } from 'ethers';
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { GatewayError } from '../errors';
import type { GaslessExecutorConfig } from './gaslessExecutorConfig';
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
  buildCreateTradeArguments,
  buildUserActionArguments,
  buildWalletUsdcTransferArguments,
  getUserActionFunctionName,
  USDC_AUTHORIZATION_ABI,
} from './gaslessTransactionEncoding';

export function createRawPrivateKeyGaslessSettlementExecutor(
  config: GaslessExecutorConfig,
  transactionOutcomeRecorder: GaslessTransactionOutcomeRecorder,
): GaslessSettlementExecutor {
  if (!config.gaslessExecutorPrivateKey) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless executor signer is not configured',
    );
  }

  const provider = createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
    chainId: config.chainId,
    quorum: config.rpcQuorum,
  });
  const signer = new Wallet(config.gaslessExecutorPrivateKey, provider);
  const escrow = AgroasysEscrow__factory.connect(config.escrowAddress, signer);
  const usdc = new Contract(config.usdcAddress, USDC_AUTHORIZATION_ABI, signer);
  const escrowInterface = new Interface(AgroasysEscrow__factory.abi);
  const usdcInterface = new Interface(USDC_AUTHORIZATION_ABI);
  const gaslessMaxGasLimit = config.gaslessMaxGasLimit ?? 1_500_000n;
  const gaslessMaxFeePerGasWei = config.gaslessMaxFeePerGasWei ?? 50_000_000_000n;
  const gaslessMaxNativeCostWei = config.gaslessMaxNativeCostWei ?? 100_000_000_000_000_000n;
  const gaslessMinExecutorBalanceWei = config.gaslessMinExecutorBalanceWei ?? 0n;
  const gaslessReceiptTimeoutMs = config.gaslessReceiptTimeoutMs ?? 120_000;

  async function assertSignerBalance(): Promise<{ executorAddress: string; balance: bigint }> {
    const executorAddress = await signer.getAddress();
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

  async function waitForConfirmedReceipt(tx: {
    hash: string;
    wait: (confirms?: number, timeout?: number) => Promise<TransactionReceipt | null>;
  }): Promise<GaslessExecutionReceipt> {
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

    const executorAddress = await signer.getAddress();
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

  async function simulate(input: GaslessCreateTradeExecutionInput): Promise<bigint> {
    await assertSignerBalance();
    const args = buildCreateTradeArguments(input);
    await escrow.createTradeWithAuthorization.staticCall(...args);
    const gasEstimate = await escrow.createTradeWithAuthorization.estimateGas(...args);
    if (gasEstimate > gaslessMaxGasLimit) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'Gasless create-trade gas estimate exceeds cap',
        {
          gasEstimate: gasEstimate.toString(),
          gasCap: gaslessMaxGasLimit.toString(),
        },
      );
    }

    return gasEstimate;
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

  async function simulateUserAction(input: GaslessUserActionExecutionInput): Promise<bigint> {
    await assertSignerBalance();
    const args = buildUserActionArguments(input);
    let gasEstimate: bigint;

    if (input.action === 'open_dispute') {
      await escrow.openDisputeWithAuthorization.staticCall(...args);
      gasEstimate = await escrow.openDisputeWithAuthorization.estimateGas(...args);
    } else if (input.action === 'cancel_locked_timeout') {
      await escrow.cancelLockedTradeAfterTimeoutWithAuthorization.staticCall(...args);
      gasEstimate = await escrow.cancelLockedTradeAfterTimeoutWithAuthorization.estimateGas(
        ...args,
      );
    } else if (input.action === 'refund_in_transit_timeout') {
      await escrow.refundInTransitAfterTimeoutWithAuthorization.staticCall(...args);
      gasEstimate = await escrow.refundInTransitAfterTimeoutWithAuthorization.estimateGas(...args);
    } else if (input.action === 'finalize_after_dispute_window') {
      await escrow.finalizeAfterDisputeWindowWithAuthorization.staticCall(...args);
      gasEstimate = await escrow.finalizeAfterDisputeWindowWithAuthorization.estimateGas(...args);
    } else {
      await escrow.finalizeAfterInspectionAcceptanceWithAuthorization.staticCall(...args);
      gasEstimate = await escrow.finalizeAfterInspectionAcceptanceWithAuthorization.estimateGas(
        ...args,
      );
    }

    if (gasEstimate > gaslessMaxGasLimit) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'Gasless user-action gas estimate exceeds cap',
        {
          action: input.action,
          gasEstimate: gasEstimate.toString(),
          gasCap: gaslessMaxGasLimit.toString(),
        },
      );
    }

    return gasEstimate;
  }

  async function simulateOperatorAction(
    input: GaslessOperatorActionExecutionInput,
  ): Promise<bigint> {
    await assertSignerBalance();
    await escrow.finalizeAfterDisputeWindow.staticCall(input.tradeId);
    const gasEstimate = await escrow.finalizeAfterDisputeWindow.estimateGas(input.tradeId);
    if (gasEstimate > gaslessMaxGasLimit) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'Gasless operator-action gas estimate exceeds cap',
        {
          action: input.action,
          gasEstimate: gasEstimate.toString(),
          gasCap: gaslessMaxGasLimit.toString(),
        },
      );
    }

    return gasEstimate;
  }

  async function simulateWalletUsdcTransfer(
    input: GaslessWalletUsdcTransferExecutionInput,
  ): Promise<bigint> {
    await assertSignerBalance();
    const transfer = usdc.getFunction('transferWithAuthorization');
    const args = buildWalletUsdcTransferArguments(input);
    await transfer.staticCall(...args);
    const gasEstimate = await transfer.estimateGas(...args);
    if (gasEstimate > gaslessMaxGasLimit) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'Sponsored USDC transfer gas estimate exceeds cap',
        { gasEstimate: gasEstimate.toString(), gasCap: gaslessMaxGasLimit.toString() },
      );
    }
    return gasEstimate;
  }

  async function signAndBroadcast(
    input: {
      requestId: string;
      operation: string;
      resourceType: 'settlement_handoff' | 'platform_transfer';
      resourceId: string;
      destinationAddress: string;
      data: string;
    },
    gasLimit: bigint,
    feeOverrides: {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    },
  ): Promise<TransactionResponse> {
    const transaction: TransactionRequest = {
      to: input.destinationAddress,
      chainId: config.chainId,
      value: 0n,
      data: input.data,
      nonce: await provider.getTransactionCount(signer.address, 'pending'),
      gasLimit,
      ...feeOverrides,
    };
    const signedTransaction = await signer.signTransaction(transaction);
    return broadcastPersistedGaslessTransaction(
      signedTransaction,
      {
        applicationRequestId: input.requestId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        operation: input.operation,
      },
      transactionOutcomeRecorder,
      (signed) => provider.broadcastTransaction(signed),
    );
  }

  return {
    async simulateCreateTrade(input) {
      return {
        gasEstimate: await simulate(input),
      };
    },

    async executeCreateTrade(input) {
      const gasEstimate = await simulate(input);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await signAndBroadcast(
        {
          requestId: input.requestId,
          operation: input.action,
          resourceType: 'settlement_handoff',
          resourceId: input.handoffId,
          destinationAddress: config.escrowAddress,
          data: escrowInterface.encodeFunctionData(
            'createTradeWithAuthorization',
            buildCreateTradeArguments(input),
          ),
        },
        gasEstimate,
        feeOverrides,
      );

      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },

    async simulateUserAction(input) {
      return {
        gasEstimate: await simulateUserAction(input),
      };
    },

    async executeUserAction(input) {
      const gasEstimate = await simulateUserAction(input);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await signAndBroadcast(
        {
          requestId: input.requestId,
          operation: input.action,
          resourceType: 'settlement_handoff',
          resourceId: input.handoffId,
          destinationAddress: config.escrowAddress,
          data: escrowInterface.encodeFunctionData(
            getUserActionFunctionName(input.action),
            buildUserActionArguments(input),
          ),
        },
        gasEstimate,
        feeOverrides,
      );
      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },

    async simulateOperatorAction(input) {
      return {
        gasEstimate: await simulateOperatorAction(input),
      };
    },

    async executeOperatorAction(input) {
      const gasEstimate = await simulateOperatorAction(input);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await signAndBroadcast(
        {
          requestId: input.requestId,
          operation: input.action,
          resourceType: 'settlement_handoff',
          resourceId: input.handoffId,
          destinationAddress: config.escrowAddress,
          data: escrowInterface.encodeFunctionData('finalizeAfterDisputeWindow', [input.tradeId]),
        },
        gasEstimate,
        feeOverrides,
      );
      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },

    async simulateWalletUsdcTransfer(input) {
      return { gasEstimate: await simulateWalletUsdcTransfer(input) };
    },

    async executeWalletUsdcTransfer(input) {
      const gasEstimate = await simulateWalletUsdcTransfer(input);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await signAndBroadcast(
        {
          requestId: input.requestId,
          operation: input.action,
          resourceType: 'platform_transfer',
          resourceId: input.platformTransferId,
          destinationAddress: config.usdcAddress,
          data: usdcInterface.encodeFunctionData(
            'transferWithAuthorization',
            buildWalletUsdcTransferArguments(input),
          ),
        },
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

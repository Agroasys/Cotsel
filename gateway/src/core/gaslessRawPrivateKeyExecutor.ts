/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Contract, NonceManager, TransactionReceipt, Wallet } from 'ethers';
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
import { isGaslessNonceDriftError } from './gaslessRelayerRuntime';
import {
  buildCreateTradeArguments,
  buildUserActionArguments,
  buildWalletUsdcTransferArguments,
  USDC_AUTHORIZATION_ABI,
} from './gaslessTransactionEncoding';

export function createRawPrivateKeyGaslessSettlementExecutor(
  config: GaslessExecutorConfig,
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
  const signer = new NonceManager(new Wallet(config.gaslessExecutorPrivateKey, provider));
  const escrow = AgroasysEscrow__factory.connect(config.escrowAddress, signer);
  const usdc = new Contract(config.usdcAddress, USDC_AUTHORIZATION_ABI, signer);
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
    const receipt = await tx.wait(1, gaslessReceiptTimeoutMs);
    if (!receipt) {
      throw new GatewayError(
        502,
        'UPSTREAM_UNAVAILABLE',
        'Gasless transaction receipt was not available',
        {
          txHash: tx.hash,
        },
      );
    }
    if (receipt.status !== 1) {
      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Gasless transaction reverted on-chain', {
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    }

    const executorAddress = await signer.getAddress();
    const executorBalance = await provider.getBalance(executorAddress);
    const gasUsed = BigInt(receipt.gasUsed ?? 0n);
    const effectiveGasPriceWei = BigInt(receipt.gasPrice ?? 0n);

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

  async function broadcastUserAction(
    input: GaslessUserActionExecutionInput,
    gasLimit: bigint,
    feeOverrides: {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    },
  ): Promise<{ hash: string; wait: () => Promise<TransactionReceipt | null> }> {
    const args = buildUserActionArguments(input);
    if (input.action === 'open_dispute') {
      return escrow.openDisputeWithAuthorization(...args, { gasLimit, ...feeOverrides });
    }
    if (input.action === 'cancel_locked_timeout') {
      return escrow.cancelLockedTradeAfterTimeoutWithAuthorization(...args, {
        gasLimit,
        ...feeOverrides,
      });
    }
    if (input.action === 'refund_in_transit_timeout') {
      return escrow.refundInTransitAfterTimeoutWithAuthorization(...args, {
        gasLimit,
        ...feeOverrides,
      });
    }

    if (input.action === 'finalize_after_dispute_window') {
      return escrow.finalizeAfterDisputeWindowWithAuthorization(...args, {
        gasLimit,
        ...feeOverrides,
      });
    }

    return escrow.finalizeAfterInspectionAcceptanceWithAuthorization(...args, {
      gasLimit,
      ...feeOverrides,
    });
  }

  async function withFreshSignerNonce<T>(operation: () => Promise<T>): Promise<T> {
    signer.reset();
    try {
      return await operation();
    } catch (error) {
      if (!isGaslessNonceDriftError(error)) {
        throw error;
      }

      signer.reset();
      return operation();
    }
  }

  return {
    async simulateCreateTrade(input) {
      return {
        gasEstimate: await simulate(input),
      };
    },

    async executeCreateTrade(input) {
      const args = buildCreateTradeArguments(input);
      const gasEstimate = await simulate(input);
      const feeOverrides = await assertGasSpendCap(gasEstimate);
      const tx = await withFreshSignerNonce(() =>
        escrow.createTradeWithAuthorization(...args, {
          gasLimit: gasEstimate,
          ...feeOverrides,
        }),
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
      const tx = await withFreshSignerNonce(() =>
        broadcastUserAction(input, gasEstimate, feeOverrides),
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
      const tx = await withFreshSignerNonce(() =>
        escrow.finalizeAfterDisputeWindow(input.tradeId, {
          gasLimit: gasEstimate,
          ...feeOverrides,
        }),
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
      const transfer = usdc.getFunction('transferWithAuthorization');
      const tx = await withFreshSignerNonce(() =>
        transfer(...buildWalletUsdcTransferArguments(input), {
          gasLimit: gasEstimate,
          ...feeOverrides,
        }),
      );
      return {
        txHash: tx.hash,
        receipt: await waitForConfirmedReceipt(tx),
      };
    },
  };
}

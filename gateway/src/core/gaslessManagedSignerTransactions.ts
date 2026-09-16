/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Interface } from 'ethers';
import type { TransactionRequest } from 'ethers';
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import type { ManagedSignerPolicyContext } from '@agroasys/sdk';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessUserActionExecutionInput,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import {
  buildCreateTradeArguments,
  buildUserActionArguments,
  buildWalletUsdcTransferArguments,
  getUserActionFunctionName,
  USDC_AUTHORIZATION_ABI,
} from './gaslessTransactionEncoding';

interface ManagedSignerTransactionConfig {
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
}

const escrowInterface = new Interface(AgroasysEscrow__factory.abi);
const usdcInterface = new Interface(USDC_AUTHORIZATION_ABI);

export function buildManagedCreateTradeTransaction(
  config: ManagedSignerTransactionConfig,
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

export function buildManagedUserActionTransaction(
  config: ManagedSignerTransactionConfig,
  input: GaslessUserActionExecutionInput,
  from: string,
): TransactionRequest {
  return {
    from,
    to: config.escrowAddress,
    chainId: config.chainId,
    value: 0n,
    data: escrowInterface.encodeFunctionData(
      getUserActionFunctionName(input.action),
      buildUserActionArguments(input),
    ),
  };
}

export function buildManagedWalletTransferTransaction(
  config: ManagedSignerTransactionConfig,
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

export function createTradePolicyContext(
  input: GaslessCreateTradeExecutionInput,
): ManagedSignerPolicyContext {
  return {
    kind: 'create_trade',
    resourceId: input.handoffId,
    actorAddress: input.buyerAddress,
    supplierAddress: input.supplierAddress,
    authorizationNonce: input.buyerAuthorization.nonce,
    authorizationDeadline: input.buyerAuthorization.deadline,
    usdcAuthorizationNonce: input.usdcAuthorization.nonce,
    usdcValidAfter: input.usdcAuthorization.validAfter,
    usdcValidBefore: input.usdcAuthorization.validBefore,
  };
}

export function userActionPolicyContext(
  input: GaslessUserActionExecutionInput,
): ManagedSignerPolicyContext {
  return {
    kind: 'user_action',
    resourceId: input.handoffId,
    actorAddress: input.userAddress,
    tradeId: input.tradeId,
    authorizationNonce: input.userAuthorization.nonce,
    authorizationDeadline: input.userAuthorization.deadline,
  };
}

export function walletTransferPolicyContext(
  input: GaslessWalletUsdcTransferExecutionInput,
): ManagedSignerPolicyContext {
  return {
    kind: 'wallet_usdc_transfer',
    resourceId: input.platformTransferId,
    actorAddress: input.from,
    recipientAddress: input.to,
    amount: input.value,
    validAfter: input.validAfter,
    validBefore: input.validBefore,
    authorizationNonce: input.nonce,
    authorizationDomainName: input.authorizationDomainName,
  };
}

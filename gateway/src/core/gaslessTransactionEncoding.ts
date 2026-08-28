/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  GaslessCreateTradeExecutionInput,
  GaslessUserAction,
  GaslessUserActionExecutionInput,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';

export const USDC_AUTHORIZATION_ABI = [
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
] as const;

export function buildCreateTradeArguments(input: GaslessCreateTradeExecutionInput) {
  return [
    input.buyerAddress,
    input.supplierAddress,
    input.totalAmount,
    input.logisticsAmount,
    input.platformFeesAmount,
    input.supplierFirstTranche,
    input.supplierSecondTranche,
    input.ricardianHash,
    input.buyerAuthorization.nonce,
    input.buyerAuthorization.deadline,
    input.buyerAuthorization.signature,
    {
      validAfter: input.usdcAuthorization.validAfter,
      validBefore: input.usdcAuthorization.validBefore,
      nonce: input.usdcAuthorization.nonce,
      v: input.usdcAuthorization.v,
      r: input.usdcAuthorization.r,
      s: input.usdcAuthorization.s,
    },
  ] as const;
}

export function buildUserActionArguments(input: GaslessUserActionExecutionInput) {
  return [
    input.tradeId,
    input.userAuthorization.nonce,
    input.userAuthorization.deadline,
    input.userAuthorization.signature,
  ] as const;
}

export function getUserActionFunctionName(
  action: GaslessUserAction,
):
  | 'openDisputeWithAuthorization'
  | 'cancelLockedTradeAfterTimeoutWithAuthorization'
  | 'refundInTransitAfterTimeoutWithAuthorization'
  | 'finalizeAfterDisputeWindowWithAuthorization'
  | 'finalizeAfterInspectionAcceptanceWithAuthorization' {
  switch (action) {
    case 'open_dispute':
      return 'openDisputeWithAuthorization';
    case 'cancel_locked_timeout':
      return 'cancelLockedTradeAfterTimeoutWithAuthorization';
    case 'refund_in_transit_timeout':
      return 'refundInTransitAfterTimeoutWithAuthorization';
    case 'finalize_after_dispute_window':
      return 'finalizeAfterDisputeWindowWithAuthorization';
    case 'finalize_after_inspection_acceptance':
      return 'finalizeAfterInspectionAcceptanceWithAuthorization';
  }
}

export function buildWalletUsdcTransferArguments(input: GaslessWalletUsdcTransferExecutionInput) {
  return [
    input.from,
    input.to,
    input.value,
    input.validAfter,
    input.validBefore,
    input.nonce,
    input.v,
    input.r,
    input.s,
  ] as const;
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress } from 'ethers';
import { GatewayError } from '../errors';
import { createGaslessPayloadHash } from './gaslessRequestNormalization';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessOperatorActionExecutionInput,
  GaslessUserActionExecutionInput,
} from './gaslessExecutionTypes';
import type { SettlementHandoffRecord } from './settlementStore';

export function assertAmountsMatchAuthorization(input: GaslessCreateTradeExecutionInput): void {
  const expectedTotal =
    BigInt(input.logisticsAmount) +
    BigInt(input.platformFeesAmount) +
    BigInt(input.supplierFirstTranche) +
    BigInt(input.supplierSecondTranche);

  if (BigInt(input.totalAmount) !== expectedTotal) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'totalAmount must match settlement amount breakdown',
      { totalAmount: input.totalAmount, expectedTotal: expectedTotal.toString() },
    );
  }
  if (input.totalAmount !== input.usdcAuthorization.value) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'totalAmount must match usdcAuthorization.value',
      {
        totalAmount: input.totalAmount,
        usdcAuthorizationValue: input.usdcAuthorization.value,
      },
    );
  }
}

export function assertAuthorizationBindings(
  input: GaslessCreateTradeExecutionInput,
  now: Date,
): void {
  if (input.usdcAuthorization.from !== input.buyerAddress) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'buyerAddress must match usdcAuthorization.from',
      {
        buyerAddress: input.buyerAddress,
        usdcAuthorizationFrom: input.usdcAuthorization.from,
      },
    );
  }
  if (input.usdcAuthorization.to !== input.contractAddress) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'usdcAuthorization.to must match contractAddress',
      {
        contractAddress: input.contractAddress,
        usdcAuthorizationTo: input.usdcAuthorization.to,
      },
    );
  }
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (BigInt(input.buyerAuthorization.deadline) <= nowSeconds) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'buyerAuthorization.deadline has expired', {
      buyerAuthorizationDeadline: input.buyerAuthorization.deadline,
    });
  }
  if (BigInt(input.usdcAuthorization.validAfter) > nowSeconds) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'usdcAuthorization.validAfter is in the future',
      { usdcAuthorizationValidAfter: input.usdcAuthorization.validAfter },
    );
  }
  if (BigInt(input.usdcAuthorization.validBefore) <= nowSeconds) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'usdcAuthorization.validBefore has expired', {
      usdcAuthorizationValidBefore: input.usdcAuthorization.validBefore,
    });
  }
}

export function assertUserAuthorizationBindings(
  input: GaslessUserActionExecutionInput,
  now: Date,
): void {
  if (BigInt(input.userAuthorization.deadline) <= BigInt(Math.floor(now.getTime() / 1000))) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'userAuthorization.deadline has expired', {
      userAuthorizationDeadline: input.userAuthorization.deadline,
    });
  }
}

export function assertHandoffMatchesExecution(
  handoff: SettlementHandoffRecord,
  input: GaslessCreateTradeExecutionInput,
): void {
  if (handoff.ricardianHash && handoff.ricardianHash !== input.ricardianHash) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'gasless execution ricardianHash does not match settlement handoff',
      {
        handoffId: handoff.handoffId,
        handoffRicardianHash: handoff.ricardianHash,
        ricardianHash: input.ricardianHash,
      },
    );
  }
}

export function assertContractMatchesRuntime(
  input:
    | GaslessCreateTradeExecutionInput
    | GaslessUserActionExecutionInput
    | GaslessOperatorActionExecutionInput,
  expectedContractAddress: string,
): void {
  const expected = getAddress(expectedContractAddress);
  if (input.contractAddress !== expected) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'contractAddress is not allowlisted', {
      contractAddress: input.contractAddress,
      expectedContractAddress: expected,
    });
  }
}

function assertPayloadHash(
  input:
    | GaslessCreateTradeExecutionInput
    | GaslessUserActionExecutionInput
    | GaslessOperatorActionExecutionInput,
): void {
  const {
    payloadHash: _payloadHash,
    requestId: _requestId,
    sourceApiKeyId: _sourceApiKeyId,
    ...hashable
  } = input;
  const expectedPayloadHash = createGaslessPayloadHash(hashable);
  if (input.payloadHash !== expectedPayloadHash) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'payloadHash does not match request payload', {
      payloadHash: input.payloadHash,
      expectedPayloadHash,
    });
  }
}

export const assertCreateTradePayloadHash = assertPayloadHash;
export const assertUserActionPayloadHash = assertPayloadHash;
export const assertOperatorActionPayloadHash = assertPayloadHash;

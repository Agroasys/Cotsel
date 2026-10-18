import type { UserActionFundingVerifier } from './userActionFundingVerification';
import {
  parseSettlementUserActionBinding,
  assertUserActionMatchesBinding,
} from './settlementUserActionBinding';
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress } from 'ethers';
import { GatewayError } from '../errors';
import { createGaslessPayloadHash } from './gaslessRequestNormalization';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessUserActionExecutionInput,
} from './gaslessExecutionTypes';
import type { SettlementHandoffRecord } from './settlementStore';
import {
  parseSettlementExecutionBinding,
  assertExecutionMatchesTypedBinding,
} from './settlementExecutionBinding';

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
  tokenAddress: string,
): void {
  if (
    !handoff.ricardianHash ||
    handoff.ricardianHash.toLowerCase() !== input.ricardianHash.toLowerCase()
  ) {
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
  if (!input.sourceApiKeyId || handoff.sourceApiKeyId !== input.sourceApiKeyId) {
    throw new GatewayError(
      403,
      'FORBIDDEN',
      'gasless execution must use the handoff issuing service identity',
    );
  }
  if (
    handoff.phase !== 'gasless_create_trade' ||
    handoff.settlementChannel !== 'cotsel_escrow' ||
    !handoff.executionBinding
  ) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'gasless execution does not match the immutable handoff scope',
    );
  }
  const binding = parseSettlementExecutionBinding(handoff.executionBinding, input.sourceApiKeyId);
  assertExecutionMatchesTypedBinding(binding, input, tokenAddress);
}

/** No user-action binding is accepted by this compatibility release. Observation remains available. */
export function requireReviewedUserActionCapability(): never {
  throw new GatewayError(
    409,
    'CONFLICT',
    'settlement_client_upgrade_required: A complete immutable user-action binding is required.',
    { reason: 'settlement_client_upgrade_required' },
  );
}

export function assertContractMatchesRuntime(
  input: GaslessCreateTradeExecutionInput | GaslessUserActionExecutionInput,
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
  input: GaslessCreateTradeExecutionInput | GaslessUserActionExecutionInput,
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

export type LoadUserActionHandoff = (id: string) => Promise<SettlementHandoffRecord | null>;
/** Shared by the workflow and both executor custody paths, before signer or capacity use. */
export async function validateBoundUserAction(
  input: GaslessUserActionExecutionInput,
  load: LoadUserActionHandoff | undefined,
  tokenAddress: string,
  verifyFunding?: UserActionFundingVerifier,
  isCommittedReplay?: (input: GaslessUserActionExecutionInput) => Promise<boolean>,
): Promise<void> {
  if (
    !load ||
    !input.actionPackageId ||
    !input.sourceOperationId ||
    !input.approvalScopeFingerprint
  )
    return requireReviewedUserActionCapability();
  const handoff = await load(input.handoffId);
  if (
    !handoff ||
    handoff.sourceApiKeyId !== input.sourceApiKeyId ||
    handoff.phase !== 'gasless_user_action' ||
    handoff.settlementChannel !== 'cotsel_escrow' ||
    handoff.tradeId !== input.tradeId ||
    handoff.externalReference !== input.sourceOperationId
  )
    throw new GatewayError(
      409,
      'CONFLICT',
      'Original immutable owned user-action handoff is required',
    );
  const binding = parseSettlementUserActionBinding(handoff.executionBinding, input.sourceApiKeyId);
  assertUserActionMatchesBinding(binding, input, tokenAddress);
  assertUserActionPayloadHash(input);
  if (isCommittedReplay && (await isCommittedReplay(input))) return;
  if (['submitted', 'confirmed', 'reconciled', 'failed'].includes(handoff.executionStatus))
    throw new GatewayError(409, 'CONFLICT', 'Original user-action execution requires observation');
  if (!verifyFunding)
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Independent user-action funding verifier is required',
    );
  await verifyFunding(binding);
}

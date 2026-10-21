/** SPDX-License-Identifier: Apache-2.0 */
import type { GaslessUserActionExecutionInput } from '../gaslessExecutionTypes';
import { GatewayError } from '../../errors';
const fields = [
  'action',
  'actionPackageId',
  'sourceOperationId',
  'approvalScopeFingerprint',
  'handoffId',
  'chainId',
  'contractAddress',
  'expiresAt',
  'payloadHash',
  'userAddress',
  'tradeId',
  'userAuthorization',
];
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'Complete immutable user-action body is required',
    );
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048)
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Invalid immutable user-action field');
  return value;
}
/** Caller cannot supply service identity or either request identity through JSON. */
export function parseOwnedUserAction(
  body: unknown,
  requestId: string,
  owner: string | null,
): GaslessUserActionExecutionInput {
  if (!owner) throw new GatewayError(403, 'FORBIDDEN', 'Issuing service identity is required');
  const value = object(body, fields),
    authorization = object(value.userAuthorization, ['nonce', 'deadline', 'signature']);
  if (
    typeof value.chainId !== 'number' ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId < 1
  )
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Invalid user-action chain');
  const input = {
    action: string(value.action),
    actionPackageId: string(value.actionPackageId),
    sourceOperationId: string(value.sourceOperationId),
    approvalScopeFingerprint: string(value.approvalScopeFingerprint),
    handoffId: string(value.handoffId),
    chainId: value.chainId,
    contractAddress: string(value.contractAddress),
    expiresAt: string(value.expiresAt),
    payloadHash: string(value.payloadHash),
    userAddress: string(value.userAddress),
    tradeId: string(value.tradeId),
    userAuthorization: {
      nonce: string(authorization.nonce),
      deadline: string(authorization.deadline),
      signature: string(authorization.signature),
    },
    requestId,
    sourceApiKeyId: owner,
  };
  if (
    ![
      'finalize_after_inspection_acceptance',
      'cancel_locked_timeout',
      'refund_in_transit_timeout',
    ].includes(input.action)
  )
    throw new GatewayError(409, 'CONFLICT', 'User action is unsupported');
  return input as GaslessUserActionExecutionInput;
}

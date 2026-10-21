/** SPDX-License-Identifier: Apache-2.0 */
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { GatewayError } from '../../errors';
import type { GaslessUserActionExecutionInput } from '../gaslessExecutionTypes';
import type { SettlementHandoffRecord } from '../settlementStore';
import {
  normalizeUserActionInput,
  requireGaslessChainId,
  parseGaslessExpiry,
} from '../gaslessRequestNormalization';
import {
  assertUserAuthorizationBindings,
  assertContractMatchesRuntime,
  assertUserActionPayloadHash,
} from '../gaslessExecutionValidation';
import {
  parseSettlementUserActionBinding,
  assertUserActionMatchesBinding,
} from '../settlementUserActionBinding';
import type { UserActionFundingVerifier } from '../userActionFundingVerification';

import type { NonceOwnershipWitness } from './retirement';
export const DORMANT_ACTIONS = [
  'finalize_after_inspection_acceptance',
  'cancel_locked_timeout',
  'refund_in_transit_timeout',
] as const;
export function deny(message = 'Original user-action authority requires observation'): never {
  throw new GatewayError(409, 'CONFLICT', message);
}
export function assertDormantAction(input: GaslessUserActionExecutionInput): void {
  if (!(DORMANT_ACTIONS as readonly string[]).includes(input.action))
    deny('User action is unsupported');
}
function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]')
  )
    deny('Canonical JSON request is required');
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
export const fingerprint = (value: unknown): string => keccak256(toUtf8Bytes(stableJson(value)));
export function handoffSnapshot(
  handoff: Pick<
    SettlementHandoffRecord,
    | 'sourceApiKeyId'
    | 'phase'
    | 'settlementChannel'
    | 'tradeId'
    | 'externalReference'
    | 'executionBinding'
    | 'executionStatus'
  >,
): string {
  return fingerprint({
    owner: handoff.sourceApiKeyId,
    phase: handoff.phase,
    channel: handoff.settlementChannel,
    trade: handoff.tradeId,
    operation: handoff.externalReference,
    binding: handoff.executionBinding,
    status: handoff.executionStatus,
  });
}
export interface UserActionWitness {
  readonly checkedAt: number;
  readonly snapshot: string;
  readonly bindingFingerprint: string;
  readonly ownership: NonceOwnershipWitness;
}
export interface UserActionValidationPorts {
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  requestMaxTtlSeconds: number;
  now(): Date;
  loadHandoff(id: string): Promise<SettlementHandoffRecord | null>;
  verifyFunding: UserActionFundingVerifier;
  verifyNonceOwnership(input: GaslessUserActionExecutionInput): Promise<NonceOwnershipWitness>;
}
/** All cryptography and RPC execute before callers acquire handoff/request locks. */
export async function verifyUserAction(
  ports: UserActionValidationPorts,
  input: GaslessUserActionExecutionInput,
): Promise<UserActionWitness> {
  const checkedAt = ports.now().getTime();
  assertDormantAction(input);
  const normalized = normalizeUserActionInput(input);
  requireGaslessChainId(input.chainId, ports.chainId);
  parseGaslessExpiry(input.expiresAt, ports.requestMaxTtlSeconds, ports.now());
  assertContractMatchesRuntime(normalized, ports.escrowAddress);
  assertUserAuthorizationBindings(normalized, ports.now());
  const handoff = await ports.loadHandoff(input.handoffId);
  if (
    !handoff ||
    handoff.sourceApiKeyId !== input.sourceApiKeyId ||
    handoff.phase !== 'gasless_user_action' ||
    handoff.settlementChannel !== 'cotsel_escrow' ||
    handoff.tradeId !== input.tradeId ||
    handoff.externalReference !== input.sourceOperationId
  )
    deny('Original immutable owned user-action handoff is required');
  const binding = parseSettlementUserActionBinding(handoff.executionBinding, input.sourceApiKeyId);
  assertUserActionMatchesBinding(binding, input, ports.usdcAddress);
  assertUserActionPayloadHash(input);
  if (!['pending', 'accepted', 'queued'].includes(handoff.executionStatus)) deny();
  await ports.verifyFunding(binding);
  if (ports.now().getTime() - checkedAt > 10_000) deny('User-action preflight expired');
  const ownership = await ports.verifyNonceOwnership(input);
  if (ports.now().getTime() - checkedAt > 10_000) deny('User-action preflight expired');
  return Object.freeze({
    checkedAt,
    snapshot: handoffSnapshot(handoff),
    bindingFingerprint: fingerprint(binding),
    ownership,
  });
}
export function requestIdentity(input: GaslessUserActionExecutionInput) {
  const { requestId: _requestId, sourceApiKeyId: _owner, ...body } = input;
  return {
    owner: input.sourceApiKeyId!,
    operation: input.sourceOperationId!,
    packageId: input.actionPackageId!,
    handoffId: input.handoffId,
    chainId: input.chainId,
    escrow: getAddress(input.contractAddress).toLowerCase(),
    user: getAddress(input.userAddress).toLowerCase(),
    nonce: input.userAuthorization.nonce,
    action: input.action,
    fingerprint: fingerprint(body),
  };
}

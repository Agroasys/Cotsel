/** SPDX-License-Identifier: Apache-2.0 */
import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { GatewayError } from '../errors';
import {
  USER_ACTIONS,
  type GaslessUserAction,
  type GaslessUserActionExecutionInput,
} from './gaslessExecutionTypes';

export const USER_ACTION_BINDING_VERSION = 'agroasys.cotsel-user-action-binding.v1' as const;
export const USER_ACTION_IDS = {
  open_dispute: '1',
  cancel_locked_timeout: '2',
  refund_in_transit_timeout: '3',
  finalize_after_dispute_window: '4',
  finalize_after_inspection_acceptance: '5',
} as const;
export interface SettlementUserActionBinding {
  scopeVersion: typeof USER_ACTION_BINDING_VERSION;
  ownerServiceId: string;
  packageId: string;
  sourceOperationId: string;
  approvalScopeFingerprint: string;
  originalFundingFingerprint: string;
  phase: 'gasless_user_action';
  action: GaslessUserAction;
  signerRole: 'buyer' | 'supplier';
  signerAddress: string;
  buyerAddress: string;
  supplierAddress: string;
  chainId: string;
  escrowAddress: string;
  tokenAddress: string;
  deploymentIdentity: string;
  tradeId: string;
  nonce: string;
  deadline: string;
  expiresAt: string;
  recipient: string | null;
  amount: string;
  totalAmount: string;
  supplierSecondTranche: string;
  fundingTransactionHash: string;
  fundingBlockNumber: string;
  fundingBlockHash: string;
  executionScopeHash: string;
}
const fields = [
  'scopeVersion',
  'ownerServiceId',
  'packageId',
  'sourceOperationId',
  'approvalScopeFingerprint',
  'originalFundingFingerprint',
  'phase',
  'action',
  'signerRole',
  'signerAddress',
  'buyerAddress',
  'supplierAddress',
  'chainId',
  'escrowAddress',
  'tokenAddress',
  'deploymentIdentity',
  'tradeId',
  'nonce',
  'deadline',
  'expiresAt',
  'recipient',
  'amount',
  'totalAmount',
  'supplierSecondTranche',
  'fundingTransactionHash',
  'fundingBlockNumber',
  'fundingBlockHash',
  'executionScopeHash',
];
function invalid(): never {
  throw new GatewayError(409, 'CONFLICT', 'settlement_user_action_binding_invalid');
}
function uint(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v) && BigInt(v) <= (1n << 256n) - 1n;
}
function address(v: unknown): v is string {
  if (typeof v !== 'string' || /^0x0{40}$/.test(v)) return false;
  try {
    return getAddress(v).toLowerCase() === v;
  } catch {
    return false;
  }
}
/** Parse all generic actions; parsing is never an activation grant. */
export function parseSettlementUserActionBinding(
  value: unknown,
  owner: string | null | undefined,
): SettlementUserActionBinding {
  if (!owner) throw new GatewayError(403, 'FORBIDDEN', 'Authenticated handoff owner is required');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((k) => !(k in row)) ||
    Object.keys(row).some((k) => !fields.includes(k))
  )
    return invalid();
  if (row.ownerServiceId !== owner)
    throw new GatewayError(
      403,
      'FORBIDDEN',
      'User-action owner differs from authenticated service',
    );
  if (
    row.scopeVersion !== USER_ACTION_BINDING_VERSION ||
    row.phase !== 'gasless_user_action' ||
    !USER_ACTIONS.includes(row.action as GaslessUserAction)
  )
    return invalid();
  for (const k of ['packageId', 'sourceOperationId', 'ownerServiceId'])
    if (typeof row[k] !== 'string' || !/^\S{1,128}$/.test(row[k])) return invalid();
  for (const k of [
    'chainId',
    'tradeId',
    'nonce',
    'deadline',
    'amount',
    'totalAmount',
    'supplierSecondTranche',
    'fundingBlockNumber',
  ])
    if (!uint(row[k])) return invalid();
  for (const k of [
    'signerAddress',
    'buyerAddress',
    'supplierAddress',
    'escrowAddress',
    'tokenAddress',
  ])
    if (!address(row[k])) return invalid();
  for (const k of [
    'approvalScopeFingerprint',
    'fundingTransactionHash',
    'fundingBlockHash',
    'executionScopeHash',
  ])
    if (typeof row[k] !== 'string' || !/^0x[0-9a-f]{64}$/.test(row[k])) return invalid();
  if (
    typeof row.originalFundingFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.originalFundingFingerprint)
  )
    return invalid();
  const b = row as unknown as SettlementUserActionBinding;
  const supplier = b.action === 'finalize_after_dispute_window';
  const noPayout = b.action === 'open_dispute';
  const refund = b.action === 'cancel_locked_timeout' || b.action === 'refund_in_transit_timeout';
  if (
    b.chainId === '0' ||
    BigInt(b.chainId) > BigInt(Number.MAX_SAFE_INTEGER) ||
    b.buyerAddress === b.supplierAddress ||
    b.signerRole !== (supplier ? 'supplier' : 'buyer') ||
    b.signerAddress !== (supplier ? b.supplierAddress : b.buyerAddress) ||
    b.deploymentIdentity !== `${b.chainId}:${b.escrowAddress}:${b.tokenAddress}` ||
    typeof b.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(b.expiresAt)) ||
    new Date(b.expiresAt).toISOString() !== b.expiresAt ||
    Date.parse(b.expiresAt) % 1000 !== 0 ||
    BigInt(Date.parse(b.expiresAt) / 1000) !== BigInt(b.deadline) ||
    BigInt(b.totalAmount) <= 0n ||
    BigInt(b.supplierSecondTranche) <= 0n ||
    BigInt(b.supplierSecondTranche) >= BigInt(b.totalAmount) ||
    b.recipient !== (noPayout ? null : refund ? b.buyerAddress : b.supplierAddress) ||
    b.amount !==
      (noPayout
        ? '0'
        : b.action === 'cancel_locked_timeout'
          ? b.totalAmount
          : b.supplierSecondTranche)
  )
    return invalid();
  return b;
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(row[k])}`)
    .join(',')}}`;
}
export function createUserActionExecutionScopeHash(input: GaslessUserActionExecutionInput): string {
  const {
    handoffId: _handoffId,
    payloadHash: _payloadHash,
    requestId: _requestId,
    sourceApiKeyId: _owner,
    ...scope
  } = input;
  return keccak256(toUtf8Bytes(stable({ version: USER_ACTION_BINDING_VERSION, ...scope })));
}
export function assertUserActionMatchesBinding(
  binding: SettlementUserActionBinding,
  input: GaslessUserActionExecutionInput,
  tokenAddress: string,
): void {
  const b = parseSettlementUserActionBinding(binding, input.sourceApiKeyId);
  if (
    input.actionPackageId !== b.packageId ||
    input.sourceOperationId !== b.sourceOperationId ||
    input.approvalScopeFingerprint !== b.approvalScopeFingerprint ||
    input.action !== b.action ||
    String(input.chainId) !== b.chainId ||
    input.contractAddress.toLowerCase() !== b.escrowAddress ||
    tokenAddress.toLowerCase() !== b.tokenAddress ||
    input.userAddress.toLowerCase() !== b.signerAddress ||
    input.tradeId !== b.tradeId ||
    input.userAuthorization.nonce !== b.nonce ||
    input.userAuthorization.deadline !== b.deadline ||
    input.expiresAt !== b.expiresAt ||
    createUserActionExecutionScopeHash(input) !== b.executionScopeHash
  )
    return invalid();
  let signer: string;
  try {
    signer = verifyTypedData(
      {
        name: 'AgroasysEscrow',
        version: '1',
        chainId: b.chainId,
        verifyingContract: b.escrowAddress,
      },
      {
        UserActionAuthorization: [
          { name: 'user', type: 'address' },
          { name: 'action', type: 'uint8' },
          { name: 'tradeId', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        user: b.signerAddress,
        action: USER_ACTION_IDS[b.action],
        tradeId: b.tradeId,
        nonce: b.nonce,
        deadline: b.deadline,
      },
      input.userAuthorization.signature,
    ).toLowerCase();
  } catch {
    return invalid();
  }
  if (signer !== b.signerAddress) return invalid();
}

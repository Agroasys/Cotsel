/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
import { getAddress, Interface, isAddress, ZeroAddress } from 'ethers';
import type { GatewayConfig } from '../config/env';
import type {
  GovernanceActionAuditRecord,
  GovernanceActionCategory,
  GovernanceActionRecord,
  GovernancePreparedSigningPayload,
  GovernanceSigningArgValue,
} from './governanceStore';
import type {
  GovernanceActionPrepared,
  GovernanceBroadcastConfirmed,
  GovernanceMutationAuditInput,
} from './governanceMutationTypes';
import {
  resolveGatewayActorKey,
  type AuthorizedSignerBinding,
  type GatewayPrincipal,
} from '../middleware/auth';
import { GatewayError } from '../errors';

const GOVERNANCE_DIRECT_SIGN_ABI = new Interface([
  'function pause()',
  'function proposeUnpause()',
  'function approveUnpause()',
  'function cancelUnpauseProposal()',
  'function pauseClaims()',
  'function unpauseClaims()',
  'function claimTreasury()',
  'function proposeTreasuryPayoutAddressUpdate(address _newPayoutReceiver)',
  'function approveTreasuryPayoutAddressUpdate(uint256 _proposalId)',
  'function executeTreasuryPayoutAddressUpdate(uint256 _proposalId)',
  'function cancelExpiredTreasuryPayoutAddressUpdateProposal(uint256 _proposalId)',
  'function disableOracleEmergency()',
  'function proposeOracleUpdate(address _newOracle)',
  'function approveOracleUpdate(uint256 _proposalId)',
  'function executeOracleUpdate(uint256 _proposalId)',
  'function cancelExpiredOracleUpdateProposal(uint256 _proposalId)',
]);

export function resolveGovernanceActorId(principal: GatewayPrincipal): string {
  return resolveGatewayActorKey(principal.session);
}

export function buildGovernanceIntentHash(intentKey: string): string {
  return createHash('sha256').update(intentKey).digest('hex');
}

function normalizeAddress(value: string, field: string): string {
  if (!isAddress(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid address`);
  }

  if (value === ZeroAddress) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} cannot be the zero address`);
  }

  return getAddress(value);
}

export function normalizeAddressOrNull(value: string | null | undefined): string | null {
  if (!value || !isAddress(value)) {
    return null;
  }

  return getAddress(value);
}

export function normalizeSignerWallet(walletAddress: string): string {
  return normalizeAddress(walletAddress, 'signerWallet');
}

export function assertGovernanceSignerBinding(
  config: GatewayConfig,
  signerWallet: string,
  binding: AuthorizedSignerBinding,
): void {
  const expectedEnvironment = config.operatorSignerEnvironment ?? config.nodeEnv;
  if (
    binding.policy.result !== 'authorized' ||
    binding.policy.actionClass !== 'governance' ||
    binding.policy.environment !== expectedEnvironment ||
    binding.actionClass !== 'governance' ||
    binding.environment !== expectedEnvironment ||
    normalizeSignerWallet(binding.walletAddress) !== signerWallet
  ) {
    throw new GatewayError(
      403,
      'SIGNER_NOT_AUTHORIZED',
      'Governance action requires the exact active signer-register binding',
      {
        signerWallet,
        bindingId: binding.bindingId,
        actionClass: binding.actionClass,
        environment: binding.environment,
      },
    );
  }
}

function requireProposalId(value: number | null | undefined, message: string): number {
  if (value === null || value === undefined) {
    throw new GatewayError(500, 'INTERNAL_ERROR', message);
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'INTERNAL_ERROR', message, { proposalId: value });
  }

  return value;
}

function requireTargetAddress(value: string | null | undefined, message: string): string {
  if (!value) {
    throw new GatewayError(500, 'INTERNAL_ERROR', message);
  }

  return normalizeAddress(value, 'targetAddress');
}

function buildGovernanceArgs(input: {
  contractMethod: string;
  proposalId?: number | null;
  targetAddress?: string | null;
}): GovernanceSigningArgValue[] {
  switch (input.contractMethod) {
    case 'pause':
    case 'proposeUnpause':
    case 'approveUnpause':
    case 'cancelUnpauseProposal':
    case 'pauseClaims':
    case 'unpauseClaims':
    case 'claimTreasury':
    case 'disableOracleEmergency':
      return [];
    case 'proposeTreasuryPayoutAddressUpdate':
    case 'proposeOracleUpdate':
      return [
        requireTargetAddress(
          input.targetAddress,
          `Prepared governance action ${input.contractMethod} is missing targetAddress`,
        ),
      ];
    case 'approveTreasuryPayoutAddressUpdate':
    case 'executeTreasuryPayoutAddressUpdate':
    case 'cancelExpiredTreasuryPayoutAddressUpdateProposal':
    case 'approveOracleUpdate':
    case 'executeOracleUpdate':
    case 'cancelExpiredOracleUpdateProposal':
      return [
        requireProposalId(
          input.proposalId,
          `Prepared governance action ${input.contractMethod} is missing proposalId`,
        ),
      ];
    default:
      throw new GatewayError(
        500,
        'INTERNAL_ERROR',
        'Unsupported governance contract method for direct signing',
        {
          contractMethod: input.contractMethod,
        },
      );
  }
}

function buildPreparedPayloadHash(
  payload: Omit<GovernancePreparedSigningPayload, 'preparedPayloadHash'>,
): string {
  const canonical = [
    payload.actionId,
    payload.intentKey,
    payload.actionType,
    payload.proposalId,
    payload.expiresAt,
    payload.auditReference,
    payload.chainId,
    payload.contractAddress,
    payload.contractMethod,
    payload.args,
    [
      payload.txRequest.chainId,
      payload.txRequest.from,
      payload.txRequest.to,
      payload.txRequest.data,
      payload.txRequest.value,
      payload.txRequest.nonce,
    ],
    payload.signerWallet,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildSigningPayload(
  config: GatewayConfig,
  input: {
    actionId: string;
    intentKey: string;
    actionType: GovernanceActionCategory;
    contractMethod: string;
    proposalId?: number | null;
    targetAddress?: string | null;
    expiresAt: string;
    auditReference: string;
    nonce: number;
  },
  signerWallet: string,
): GovernancePreparedSigningPayload {
  const contractAddress = getAddress(config.escrowAddress);
  const args = buildGovernanceArgs(input);
  const data = GOVERNANCE_DIRECT_SIGN_ABI.encodeFunctionData(input.contractMethod, args);
  const normalizedSignerWallet = normalizeSignerWallet(signerWallet);
  const txRequest = {
    chainId: config.chainId,
    from: normalizedSignerWallet,
    to: contractAddress,
    data,
    value: '0',
    nonce: input.nonce,
  };

  const payload: Omit<GovernancePreparedSigningPayload, 'preparedPayloadHash'> = {
    actionId: input.actionId,
    intentKey: input.intentKey,
    actionType: input.actionType,
    proposalId: input.proposalId ?? null,
    expiresAt: input.expiresAt,
    auditReference: input.auditReference,
    chainId: config.chainId,
    contractAddress,
    contractMethod: input.contractMethod,
    args,
    txRequest,
    signerWallet: normalizedSignerWallet,
  };

  return { ...payload, preparedPayloadHash: buildPreparedPayloadHash(payload) };
}

export function buildAuditRecord(
  audit: GovernanceMutationAuditInput,
  principal: GatewayPrincipal,
  acceptedAt: string,
  signerBinding: AuthorizedSignerBinding,
): GovernanceActionAuditRecord {
  return {
    reason: audit.reason,
    evidenceLinks: audit.evidenceLinks,
    ticketRef: audit.ticketRef,
    actorSessionId: principal.sessionReference,
    ...(principal.session.accountId ? { actorAccountId: principal.session.accountId } : {}),
    actorWallet: normalizeAddressOrNull(principal.session.walletAddress),
    actorRole: principal.session.role,
    createdAt: acceptedAt,
    requestedBy: principal.session.userId,
    signerBindingId: signerBinding.bindingId,
    signerActionClass: signerBinding.actionClass,
    signerEnvironment: signerBinding.environment,
    signerPolicyResult: signerBinding.policy.result,
    signerPolicyReason: signerBinding.policy.reason,
    signerBindingWallet: signerBinding.walletAddress,
    breakGlassActive: principal.session.breakGlass?.active ?? false,
    breakGlassReason: principal.session.breakGlass?.reason ?? null,
    breakGlassExpiresAt: principal.session.breakGlass?.expiresAt ?? null,
    breakGlassReviewedAt: principal.session.breakGlass?.reviewedAt ?? null,
    breakGlassReviewedBy: principal.session.breakGlass?.reviewedBy ?? null,
    breakGlassReviewStatus: principal.session.breakGlass?.reviewStatus ?? null,
  };
}

export function toPreparedResponse(
  action: GovernanceActionRecord,
  signing: GovernancePreparedSigningPayload,
): GovernanceActionPrepared {
  if (
    action.status !== 'prepared' &&
    action.status !== 'broadcast_pending_verification' &&
    action.status !== 'broadcast'
  ) {
    throw new GatewayError(
      500,
      'INTERNAL_ERROR',
      'Prepared governance action is in an unexpected status',
      {
        actionId: action.actionId,
        status: action.status,
      },
    );
  }

  return {
    actionId: action.actionId,
    intentKey: action.intentKey,
    proposalId: action.proposalId,
    category: action.category,
    status: action.status,
    preparedAt: action.createdAt,
    expiresAt: action.expiresAt,
    signing,
  };
}

export function toConfirmedResponse(action: GovernanceActionRecord): GovernanceBroadcastConfirmed {
  if (action.status !== 'broadcast' && action.status !== 'broadcast_pending_verification') {
    throw new GatewayError(
      500,
      'INTERNAL_ERROR',
      'Confirmed governance action is in an unexpected status',
      {
        actionId: action.actionId,
        status: action.status,
      },
    );
  }

  return {
    actionId: action.actionId,
    txHash: action.txHash ?? '',
    status: action.status,
    broadcastAt: action.broadcastAt ?? action.createdAt,
    signerWallet: action.finalSignerWallet ?? null,
    verificationState: action.verificationState ?? 'not_started',
    monitoringState: action.monitoringState ?? 'not_started',
    verifiedAt: action.verifiedAt ?? null,
    blockNumber: action.blockNumber ?? null,
  };
}

export function ensurePreparedSigningPayload(
  action: GovernanceActionRecord,
): GovernancePreparedSigningPayload {
  if (!action.signing) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Prepared governance action is missing its immutable signing payload',
      { actionId: action.actionId },
    );
  }

  const signing = action.signing;
  const expectedArgs = buildGovernanceArgs(action);
  const expectedData = GOVERNANCE_DIRECT_SIGN_ABI.encodeFunctionData(
    action.contractMethod,
    expectedArgs,
  );
  const payloadWithoutHash = {
    actionId: signing.actionId,
    intentKey: signing.intentKey,
    actionType: signing.actionType,
    proposalId: signing.proposalId,
    expiresAt: signing.expiresAt,
    auditReference: signing.auditReference,
    chainId: signing.chainId,
    contractAddress: signing.contractAddress,
    contractMethod: signing.contractMethod,
    args: signing.args,
    txRequest: signing.txRequest,
    signerWallet: signing.signerWallet,
  };
  const valid =
    signing.actionId === action.actionId &&
    signing.intentKey === action.intentKey &&
    signing.actionType === action.category &&
    signing.proposalId === action.proposalId &&
    signing.expiresAt === action.expiresAt &&
    signing.auditReference === action.audit.ticketRef &&
    String(signing.chainId) === action.chainId &&
    signing.contractMethod === action.contractMethod &&
    JSON.stringify(signing.args) === JSON.stringify(expectedArgs) &&
    signing.txRequest.chainId === signing.chainId &&
    signing.txRequest.from === signing.signerWallet &&
    signing.txRequest.to === signing.contractAddress &&
    signing.txRequest.data.toLowerCase() === expectedData.toLowerCase() &&
    signing.txRequest.value === '0' &&
    Number.isSafeInteger(signing.txRequest.nonce) &&
    signing.txRequest.nonce >= 0 &&
    buildPreparedPayloadHash(payloadWithoutHash) === signing.preparedPayloadHash;

  if (!valid) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Prepared governance signing payload failed its integrity check',
      { actionId: action.actionId },
    );
  }

  return signing;
}

export function normalizeConfirmedSignerWallet(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return normalizeAddress(value, 'signerWallet');
}

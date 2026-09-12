/**
 * SPDX-License-Identifier: Apache-2.0
 */
export const GOVERNANCE_ACTION_CATEGORIES = [
  'pause',
  'unpause',
  'claims_pause',
  'claims_unpause',
  'treasury_sweep',
  'treasury_payout_receiver_update',
  'oracle_disable_emergency',
  'oracle_update',
] as const;

export const GOVERNANCE_ACTION_STATUSES = [
  'prepared',
  'broadcast_pending_verification',
  'broadcast',
  'executed',
  'stale',
  'failed',
] as const;

export const GOVERNANCE_FLOW_TYPES = ['direct_sign'] as const;
export const GOVERNANCE_VERIFICATION_STATES = [
  'not_started',
  'pending',
  'verified',
  'failed',
] as const;
export const GOVERNANCE_MONITORING_STATES = [
  'not_started',
  'pending_verification',
  'pending_confirmation',
  'confirmed',
  'finalized',
  'reverted',
  'stale',
] as const;

export type GovernanceActionCategory = (typeof GOVERNANCE_ACTION_CATEGORIES)[number];
export type GovernanceActionStatus = (typeof GOVERNANCE_ACTION_STATUSES)[number];
export type GovernanceFlowType = (typeof GOVERNANCE_FLOW_TYPES)[number];
export type GovernanceVerificationState = (typeof GOVERNANCE_VERIFICATION_STATES)[number];
export type GovernanceMonitoringState = (typeof GOVERNANCE_MONITORING_STATES)[number];

export const GOVERNANCE_OPEN_INTENT_STATUSES: readonly GovernanceActionStatus[] = [
  'prepared',
  'broadcast_pending_verification',
  'broadcast',
] as const;

export const GOVERNANCE_APPROVAL_CONTRACT_METHODS = [
  'approveUnpause',
  'approveTreasuryPayoutAddressUpdate',
  'approveOracleUpdate',
] as const;

export interface EvidenceLink {
  kind:
    | 'runbook'
    | 'incident'
    | 'ticket'
    | 'tx'
    | 'event'
    | 'document'
    | 'log'
    | 'dashboard'
    | 'other';
  uri: string;
  note?: string;
}

export type GovernanceSigningArgValue = string | number | boolean;

export interface GovernancePreparedTransactionRequest {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: string;
  nonce: number;
}

export interface GovernancePreparedSigningPayload {
  actionId: string;
  intentKey: string;
  actionType: GovernanceActionCategory;
  proposalId: number | null;
  expiresAt: string;
  auditReference: string;
  chainId: number;
  contractAddress: string;
  contractMethod: string;
  args: GovernanceSigningArgValue[];
  txRequest: GovernancePreparedTransactionRequest;
  signerWallet: string;
  preparedPayloadHash: string;
}

export interface GovernanceActionAuditRecord {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorAccountId?: string | null;
  actorWallet: string | null;
  actorRole: string;
  createdAt: string;
  requestedBy: string;
  approvedBy?: string[];
  signerBindingId?: string | null;
  signerActionClass?: string | null;
  signerEnvironment?: string | null;
  signerPolicyResult?: string | null;
  signerPolicyReason?: string | null;
  signerBindingWallet?: string | null;
  breakGlassActive?: boolean;
  breakGlassReason?: string | null;
  breakGlassExpiresAt?: string | null;
  breakGlassReviewedAt?: string | null;
  breakGlassReviewedBy?: string | null;
  breakGlassReviewStatus?: string | null;
  finalSignerWallet?: string | null;
  finalSignerVerifiedAt?: string | null;
}

export interface GovernanceActionRecord {
  actionId: string;
  intentKey: string;
  intentHash?: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  flowType: GovernanceFlowType;
  contractMethod: string;
  txHash: string | null;
  blockNumber: number | null;
  tradeId: string | null;
  chainId: string | null;
  targetAddress: string | null;
  broadcastAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  executedAt: string | null;
  requestId: string;
  correlationId: string | null;
  idempotencyKey?: string;
  actorId?: string;
  endpoint?: string;
  errorCode: string | null;
  errorMessage: string | null;
  audit: GovernanceActionAuditRecord;
  signing?: GovernancePreparedSigningPayload | null;
  finalSignerWallet?: string | null;
  verificationState?: GovernanceVerificationState;
  verificationError?: string | null;
  verifiedAt?: string | null;
  monitoringState?: GovernanceMonitoringState;
}

export interface ListGovernanceActionsInput {
  category?: GovernanceActionCategory;
  categories?: GovernanceActionCategory[];
  status?: GovernanceActionStatus;
  tradeId?: string;
  limit: number;
  cursor?: string;
}

export interface GovernanceActionCursor {
  createdAt: string;
  actionId: string;
}

export interface ListGovernanceActionsResult {
  items: GovernanceActionRecord[];
  nextCursor: string | null;
}

export interface GovernanceActionStore {
  save(action: GovernanceActionRecord): Promise<GovernanceActionRecord>;
  get(actionId: string): Promise<GovernanceActionRecord | null>;
  findOpenByIntentKey(intentKey: string, now: string): Promise<GovernanceActionRecord | null>;
  list(input: ListGovernanceActionsInput): Promise<ListGovernanceActionsResult>;
  listActiveProposalIds(category: GovernanceActionCategory): Promise<number[]>;
}

export const ACTIVE_PROPOSAL_STATUSES: readonly GovernanceActionStatus[] =
  GOVERNANCE_OPEN_INTENT_STATUSES;

export interface GovernanceActionRow {
  actionId: string;
  intentKey: string | null;
  intentHash: string | null;
  proposalId: string | number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  flowType: GovernanceFlowType;
  contractMethod: string;
  txHash: string | null;
  blockNumber: string | number | null;
  tradeId: string | null;
  chainId: string | null;
  targetAddress: string | null;
  broadcastAt: Date | null;
  requestId: string;
  correlationId: string | null;
  idempotencyKey: string | null;
  actorId: string | null;
  endpoint: string | null;
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
  actorSessionId: string;
  actorWallet: string | null;
  actorRole: string;
  requestedBy: string;
  approvedBy: string[] | null;
  actorAccountId: string | null;
  signerPolicyEvidence: Record<string, unknown> | null;
  finalSignerWallet: string | null;
  verificationState: GovernanceVerificationState | null;
  verificationError: string | null;
  verifiedAt: Date | null;
  monitoringState: GovernanceMonitoringState | null;
  signing: GovernancePreparedSigningPayload | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  executedAt: Date | null;
}

function normalizeIntentFragment(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim().toLowerCase();
}

export function isApprovalGovernanceContractMethod(contractMethod: string): boolean {
  return (GOVERNANCE_APPROVAL_CONTRACT_METHODS as readonly string[]).includes(contractMethod);
}

export function buildGovernanceIntentKey(input: {
  category: GovernanceActionCategory;
  contractMethod: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  chainId?: string | number | null;
  approverWallet?: string | null;
  signerBindingId?: string | null;
}): string {
  return [
    'v1',
    normalizeIntentFragment(input.category),
    normalizeIntentFragment(input.contractMethod),
    normalizeIntentFragment(input.proposalId),
    normalizeIntentFragment(input.targetAddress),
    normalizeIntentFragment(input.tradeId),
    normalizeIntentFragment(input.chainId),
    normalizeIntentFragment(input.approverWallet ?? null),
    normalizeIntentFragment(input.signerBindingId ?? null),
  ].join('|');
}

export function numericOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric governance field, received: ${String(value)}`);
  }

  return parsed;
}

function defaultVerificationState(
  row: Pick<GovernanceActionRow, 'status'>,
): GovernanceVerificationState {
  switch (row.status) {
    case 'prepared':
      return 'not_started';
    case 'broadcast_pending_verification':
      return 'pending';
    case 'broadcast':
    case 'executed':
      return 'verified';
    case 'failed':
      return 'failed';
    default:
      return 'not_started';
  }
}

function defaultMonitoringState(
  row: Pick<GovernanceActionRow, 'status'>,
): GovernanceMonitoringState {
  switch (row.status) {
    case 'prepared':
      return 'not_started';
    case 'broadcast_pending_verification':
      return 'pending_verification';
    case 'broadcast':
      return 'pending_confirmation';
    case 'executed':
      return 'finalized';
    case 'failed':
      return 'reverted';
    case 'stale':
      return 'stale';
    default:
      return 'not_started';
  }
}

export function mapGovernanceActionRow(row: GovernanceActionRow): GovernanceActionRecord {
  return {
    actionId: row.actionId,
    intentKey:
      row.intentKey ??
      buildGovernanceIntentKey({
        category: row.category,
        contractMethod: row.contractMethod,
        proposalId: numericOrNull(row.proposalId),
        targetAddress: row.targetAddress,
        tradeId: row.tradeId,
        chainId: row.chainId,
        approverWallet: row.actorWallet,
      }),
    intentHash: row.intentHash ?? undefined,
    proposalId: numericOrNull(row.proposalId),
    category: row.category,
    status: row.status,
    flowType: row.flowType ?? 'direct_sign',
    contractMethod: row.contractMethod,
    txHash: row.txHash,
    blockNumber: numericOrNull(row.blockNumber),
    tradeId: row.tradeId,
    chainId: row.chainId,
    targetAddress: row.targetAddress,
    broadcastAt: row.broadcastAt ? row.broadcastAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    requestId: row.requestId,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey ?? undefined,
    actorId: row.actorId ?? undefined,
    endpoint: row.endpoint ?? undefined,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    signing: row.signing ?? null,
    finalSignerWallet: row.finalSignerWallet,
    verificationState: row.verificationState ?? defaultVerificationState(row),
    verificationError: row.verificationError,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    monitoringState: row.monitoringState ?? defaultMonitoringState(row),
    audit: {
      reason: row.reason,
      evidenceLinks: row.evidenceLinks || [],
      ticketRef: row.ticketRef,
      actorSessionId: row.actorSessionId,
      ...(row.actorAccountId ? { actorAccountId: row.actorAccountId } : {}),
      actorWallet: row.actorWallet,
      actorRole: row.actorRole,
      createdAt: row.createdAt.toISOString(),
      requestedBy: row.requestedBy,
      ...(row.approvedBy && row.approvedBy.length > 0 ? { approvedBy: row.approvedBy } : {}),
      ...(row.signerPolicyEvidence ?? {}),
      ...(row.finalSignerWallet ? { finalSignerWallet: row.finalSignerWallet } : {}),
      ...(row.verifiedAt ? { finalSignerVerifiedAt: row.verifiedAt.toISOString() } : {}),
    },
  };
}

export function encodeGovernanceActionCursor(cursor: GovernanceActionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeGovernanceActionCursor(cursor: string): GovernanceActionCursor {
  const parsed = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as GovernanceActionCursor;
  if (!parsed.createdAt || !parsed.actionId) {
    throw new Error('Cursor is missing required fields');
  }

  if (Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new Error('Cursor createdAt must be an ISO timestamp');
  }

  return parsed;
}

export function nextGovernanceActionCursor(
  items: GovernanceActionRecord[],
  limit: number,
): string | null {
  if (items.length <= limit) {
    return null;
  }

  const boundary = items[limit - 1];
  return encodeGovernanceActionCursor({
    createdAt: boundary.createdAt,
    actionId: boundary.actionId,
  });
}

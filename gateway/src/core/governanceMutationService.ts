/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import { AbstractProvider, getAddress, Interface, isAddress, ZeroAddress } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { GatewayConfig } from '../config/env';
import { AuditLogEntry } from './auditLogStore';
import {
  buildGovernanceIntentKey,
  EvidenceLink,
  GovernanceActionAuditRecord,
  GovernanceActionCategory,
  GovernanceActionRecord,
  GovernanceActionStatus,
  GovernanceActionStore,
  GovernanceMonitoringState,
  GovernancePreparedSigningPayload,
  GovernanceSigningArgValue,
  GovernanceVerificationState,
} from './governanceStore';
import {
  requireWalletBoundSession,
  resolveGatewayActorKey,
  type GatewayPrincipal,
} from '../middleware/auth';
import { RequestContext } from '../middleware/requestContext';
import { GatewayError } from '../errors';
import { GovernanceWriteStore } from './governanceWriteStore';
import { validateEvidenceLink } from './evidenceValidation';

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

export interface GovernanceMutationAuditInput {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
}

export interface GovernanceMutationAccepted {
  actionId: string;
  intentKey: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: GovernanceActionStatus;
  acceptedAt: string;
  expiresAt: string | null;
}

export interface GovernanceActionPrepared {
  actionId: string;
  intentKey: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: 'prepared' | 'broadcast_pending_verification' | 'broadcast';
  preparedAt: string;
  expiresAt: string | null;
  signing: GovernancePreparedSigningPayload;
}

export interface GovernanceBroadcastConfirmed {
  actionId: string;
  txHash: string;
  status: 'broadcast' | 'broadcast_pending_verification';
  broadcastAt: string;
  signerWallet: string | null;
  verificationState: GovernanceVerificationState;
  monitoringState: GovernanceMonitoringState;
  verifiedAt: string | null;
  blockNumber: number | null;
}

export interface QueueGovernanceActionInput {
  category: GovernanceActionCategory;
  contractMethod: string;
  routePath: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  audit: GovernanceMutationAuditInput;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

export interface PrepareGovernanceActionInput {
  category: GovernanceActionCategory;
  contractMethod: string;
  routePath: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  audit: GovernanceMutationAuditInput;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

export interface ConfirmGovernanceBroadcastInput {
  actionId: string;
  txHash: string;
  signerWallet?: string | null;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
}

export interface GovernanceObservedTransaction {
  chainId: number | null;
  to: string | null;
  from: string | null;
  data: string | null;
  blockNumber: number | null;
}

export interface GovernanceObservedTransactionReceipt {
  blockNumber: number | null;
  status: 'success' | 'reverted' | 'unknown';
}

export interface GovernanceTransactionVerifier {
  getTransaction(txHash: string): Promise<GovernanceObservedTransaction | null>;
  getTransactionReceipt(txHash: string): Promise<GovernanceObservedTransactionReceipt | null>;
  getBlockNumber(): Promise<number | null>;
}

interface GovernanceVerificationOutcome {
  status: 'broadcast' | 'broadcast_pending_verification';
  verificationState: GovernanceVerificationState;
  monitoringState: GovernanceMonitoringState;
  finalSignerWallet: string | null;
  verificationError: string | null;
  verifiedAt: string | null;
  blockNumber: number | null;
}

function resolveGovernanceActorId(principal: GatewayPrincipal): string {
  return resolveGatewayActorKey(principal.session);
}

function buildGovernanceIntentHash(intentKey: string): string {
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

function normalizeAddressOrNull(value: string | null | undefined): string | null {
  if (!value || !isAddress(value)) {
    return null;
  }

  return getAddress(value);
}

function normalizeSignerWallet(walletAddress: string): string {
  return normalizeAddress(walletAddress, 'signerWallet');
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
      return [requireTargetAddress(input.targetAddress, `Prepared governance action ${input.contractMethod} is missing targetAddress`)];
    case 'approveTreasuryPayoutAddressUpdate':
    case 'executeTreasuryPayoutAddressUpdate':
    case 'cancelExpiredTreasuryPayoutAddressUpdateProposal':
    case 'approveOracleUpdate':
    case 'executeOracleUpdate':
    case 'cancelExpiredOracleUpdateProposal':
      return [requireProposalId(input.proposalId, `Prepared governance action ${input.contractMethod} is missing proposalId`)];
    default:
      throw new GatewayError(500, 'INTERNAL_ERROR', 'Unsupported governance contract method for direct signing', {
        contractMethod: input.contractMethod,
      });
  }
}

function buildPreparedPayloadHash(payload: Pick<GovernancePreparedSigningPayload, 'chainId' | 'contractAddress' | 'contractMethod' | 'args' | 'txRequest' | 'signerWallet'>): string {
  const serialized = JSON.stringify({
    chainId: payload.chainId,
    contractAddress: payload.contractAddress,
    contractMethod: payload.contractMethod,
    args: payload.args,
    txRequest: payload.txRequest,
    signerWallet: payload.signerWallet,
  });

  return createHash('sha256').update(serialized).digest('hex');
}

function buildSigningPayload(
  config: GatewayConfig,
  input: {
    contractMethod: string;
    proposalId?: number | null;
    targetAddress?: string | null;
  },
  signerWallet: string,
): GovernancePreparedSigningPayload {
  const contractAddress = getAddress(config.escrowAddress);
  const args = buildGovernanceArgs(input);
  const data = GOVERNANCE_DIRECT_SIGN_ABI.encodeFunctionData(input.contractMethod, args);
  const normalizedSignerWallet = normalizeSignerWallet(signerWallet);
  const txRequest = {
    chainId: config.chainId,
    to: contractAddress,
    data,
    value: '0',
  };

  return {
    chainId: config.chainId,
    contractAddress,
    contractMethod: input.contractMethod,
    args,
    txRequest,
    signerWallet: normalizedSignerWallet,
    preparedPayloadHash: buildPreparedPayloadHash({
      chainId: config.chainId,
      contractAddress,
      contractMethod: input.contractMethod,
      args,
      txRequest,
      signerWallet: normalizedSignerWallet,
    }),
  };
}

function buildAuditRecord(
  audit: GovernanceMutationAuditInput,
  principal: GatewayPrincipal,
  acceptedAt: string,
): GovernanceActionAuditRecord {
  const actorWallet = requireWalletBoundSession(
    principal,
    'Governance mutation preparation',
  );
  return {
    reason: audit.reason,
    evidenceLinks: audit.evidenceLinks,
    ticketRef: audit.ticketRef,
    actorSessionId: principal.sessionReference,
    ...(principal.session.accountId ? { actorAccountId: principal.session.accountId } : {}),
    actorWallet,
    actorRole: principal.session.role,
    createdAt: acceptedAt,
    requestedBy: principal.session.userId,
  };
}

function toPreparedResponse(action: GovernanceActionRecord, signing: GovernancePreparedSigningPayload): GovernanceActionPrepared {
  if (action.status !== 'prepared' && action.status !== 'broadcast_pending_verification' && action.status !== 'broadcast') {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Prepared governance action is in an unexpected status', {
      actionId: action.actionId,
      status: action.status,
    });
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

function toConfirmedResponse(action: GovernanceActionRecord): GovernanceBroadcastConfirmed {
  if (action.status !== 'broadcast' && action.status !== 'broadcast_pending_verification') {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Confirmed governance action is in an unexpected status', {
      actionId: action.actionId,
      status: action.status,
    });
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

function ensurePreparedSigningPayload(
  config: GatewayConfig,
  action: GovernanceActionRecord,
  fallbackSignerWallet: string,
): GovernancePreparedSigningPayload {
  if (action.signing) {
    return action.signing;
  }

  return buildSigningPayload(
    config,
    {
      contractMethod: action.contractMethod,
      proposalId: action.proposalId,
      targetAddress: action.targetAddress,
    },
    fallbackSignerWallet,
  );
}

function normalizeConfirmedSignerWallet(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return normalizeAddress(value, 'signerWallet');
}

export function validateGovernanceAuditInput(raw: unknown): GovernanceMutationAuditInput {
  if (!raw || typeof raw !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }

  const body = raw as Record<string, unknown>;
  if (body.actionId !== undefined) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'actionId is server-generated and must not be provided by the client');
  }
  const audit = body.audit;
  if (!audit || typeof audit !== 'object') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Request body must include audit metadata');
  }

  const auditRecord = audit as Record<string, unknown>;
  const reason = typeof auditRecord.reason === 'string' ? auditRecord.reason.trim() : '';
  const ticketRef = typeof auditRecord.ticketRef === 'string' ? auditRecord.ticketRef.trim() : '';
  const evidenceLinks = Array.isArray(auditRecord.evidenceLinks) ? auditRecord.evidenceLinks as EvidenceLink[] : [];

  if (reason.length < 8 || reason.length > 2000) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.reason must be between 8 and 2000 characters');
  }

  if (ticketRef.length < 2 || ticketRef.length > 128) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.ticketRef must be between 2 and 128 characters');
  }

  if (evidenceLinks.length < 1) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'audit.evidenceLinks must contain at least one item');
  }

  evidenceLinks.forEach((link, index) => validateEvidenceLink(link, index));

  return {
    reason,
    evidenceLinks: evidenceLinks.map((link) => ({
      kind: link.kind,
      uri: link.uri.trim(),
      ...(link.note ? { note: link.note.trim() } : {}),
    })),
    ticketRef,
  };
}

export function validateProposalId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter proposalId must be a non-negative integer');
  }

  return Number.parseInt(raw, 10);
}

export function validateAddressInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid address`);
  }

  if (value === ZeroAddress) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} cannot be the zero address`);
  }

  return value;
}

class RpcGovernanceTransactionVerifier implements GovernanceTransactionVerifier {
  constructor(private readonly provider: AbstractProvider) {}

  async getTransaction(txHash: string): Promise<GovernanceObservedTransaction | null> {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) {
      return null;
    }

    const chainId = tx.chainId !== undefined && tx.chainId !== null
      ? Number(tx.chainId)
      : null;

    return {
      chainId: Number.isFinite(chainId) ? chainId : null,
      to: tx.to ?? null,
      from: tx.from ?? null,
      data: tx.data ?? null,
      blockNumber: tx.blockNumber ?? null,
    };
  }

  async getTransactionReceipt(txHash: string): Promise<GovernanceObservedTransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return null;
    }

    const status = receipt.status === 1
      ? 'success'
      : receipt.status === 0
        ? 'reverted'
        : 'unknown';

    return {
      blockNumber: receipt.blockNumber ?? null,
      status,
    };
  }

  async getBlockNumber(): Promise<number | null> {
    return this.provider.getBlockNumber();
  }
}

export function createDefaultTransactionVerifier(config: GatewayConfig): GovernanceTransactionVerifier {
  return new RpcGovernanceTransactionVerifier(
    createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
      chainId: config.chainId,
      stallTimeoutMs: config.rpcReadTimeoutMs,
    }),
  );
}

export class GovernanceMutationService {
  private readonly verifier: GovernanceTransactionVerifier;

  constructor(
    private readonly config: GatewayConfig,
    private readonly actionStore: GovernanceActionStore,
    private readonly writeStore: GovernanceWriteStore,
    verifier?: GovernanceTransactionVerifier,
  ) {
    this.verifier = verifier ?? createDefaultTransactionVerifier(config);
  }

  async queueAction(input: QueueGovernanceActionInput): Promise<GovernanceMutationAccepted> {
    const acceptedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(acceptedAt) + (this.config.governanceQueueTtlSeconds * 1000)).toISOString();
    const approverWallet = requireWalletBoundSession(
      input.principal,
      'Governance mutation queuing',
    );
    const intentKey = buildGovernanceIntentKey({
      category: input.category,
      contractMethod: input.contractMethod,
      proposalId: input.proposalId ?? null,
      targetAddress: input.targetAddress ?? null,
      tradeId: input.tradeId ?? null,
      chainId: this.config.chainId,
      approverWallet,
    });
    const intentHash = buildGovernanceIntentHash(intentKey);
    const actionId = randomUUID();
    const actorId = resolveGovernanceActorId(input.principal);

    const record: GovernanceActionRecord = {
      actionId,
      intentKey,
      intentHash,
      proposalId: input.proposalId ?? null,
      category: input.category,
      status: 'requested',
      contractMethod: input.contractMethod,
      txHash: null,
      extrinsicHash: null,
      blockNumber: null,
      tradeId: input.tradeId ?? null,
      chainId: String(this.config.chainId),
      targetAddress: input.targetAddress ?? null,
      createdAt: acceptedAt,
      expiresAt,
      executedAt: null,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      endpoint: input.routePath,
      errorCode: null,
      errorMessage: null,
      flowType: 'executor',
      broadcastAt: null,
      audit: buildAuditRecord(input.audit, input.principal, acceptedAt),
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.queued',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'requested',
      metadata: {
        actionId,
        category: input.category,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
        actorId,
        intentHash,
        idempotencyKey: input.idempotencyKey,
      },
    };

    const duplicateAuditEntry = (existing: GovernanceActionRecord): AuditLogEntry => ({
      eventType: 'governance.action.duplicate_reused',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: existing.actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: existing.status,
      metadata: {
        actionId: existing.actionId,
        category: existing.category,
        proposalId: existing.proposalId,
        targetAddress: existing.targetAddress,
        intentKey: existing.intentKey,
        intentHash: existing.intentHash ?? intentHash,
        actorId: existing.actorId ?? actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const saved = await this.writeStore.saveQueuedActionWithIntentDedupe(
      record,
      auditEntry,
      duplicateAuditEntry,
      acceptedAt,
    );

    const stored = saved.created ? record : (await this.actionStore.get(saved.action.actionId)) ?? saved.action;

    return {
      actionId: stored.actionId,
      intentKey: stored.intentKey,
      proposalId: stored.proposalId,
      category: stored.category,
      status: stored.status,
      acceptedAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  }

  async prepareAction(input: PrepareGovernanceActionInput): Promise<GovernanceActionPrepared> {
    const signerWallet = normalizeSignerWallet(requireWalletBoundSession(input.principal, 'Preparing privileged governance approval'));
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(preparedAt) + (this.config.governanceQueueTtlSeconds * 1000)).toISOString();
    const intentKey = buildGovernanceIntentKey({
      category: input.category,
      contractMethod: input.contractMethod,
      proposalId: input.proposalId ?? null,
      targetAddress: input.targetAddress ?? null,
      tradeId: input.tradeId ?? null,
      chainId: this.config.chainId,
      approverWallet: signerWallet,
    });
    const intentHash = buildGovernanceIntentHash(intentKey);
    const actionId = randomUUID();
    const actorId = resolveGovernanceActorId(input.principal);
    const signing = buildSigningPayload(
      this.config,
      {
        contractMethod: input.contractMethod,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
      },
      signerWallet,
    );

    const record: GovernanceActionRecord = {
      actionId,
      intentKey,
      intentHash,
      proposalId: input.proposalId ?? null,
      category: input.category,
      status: 'prepared',
      flowType: 'direct_sign',
      contractMethod: input.contractMethod,
      txHash: null,
      extrinsicHash: null,
      blockNumber: null,
      tradeId: input.tradeId ?? null,
      chainId: String(this.config.chainId),
      targetAddress: input.targetAddress ?? null,
      broadcastAt: null,
      createdAt: preparedAt,
      expiresAt,
      executedAt: null,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      endpoint: input.routePath,
      errorCode: null,
      errorMessage: null,
      signing,
      finalSignerWallet: null,
      verificationState: 'not_started',
      verificationError: null,
      verifiedAt: null,
      monitoringState: 'not_started',
      audit: buildAuditRecord(input.audit, input.principal, preparedAt),
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.prepared',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: 'prepared',
      metadata: {
        actionId,
        category: input.category,
        contractMethod: input.contractMethod,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
        actorId,
        intentHash,
        preparedPayloadHash: signing.preparedPayloadHash,
        signerWallet: signing.signerWallet,
        idempotencyKey: input.idempotencyKey,
      },
    };

    const duplicateAuditEntry = (existing: GovernanceActionRecord): AuditLogEntry => ({
      eventType: 'governance.action.duplicate_reused',
      route: input.routePath,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: existing.actionId,
      idempotencyKey: input.idempotencyKey,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: existing.status,
      metadata: {
        actionId: existing.actionId,
        category: existing.category,
        contractMethod: existing.contractMethod,
        proposalId: existing.proposalId,
        targetAddress: existing.targetAddress,
        flowType: existing.flowType,
        intentKey: existing.intentKey,
        intentHash: existing.intentHash ?? intentHash,
        actorId: existing.actorId ?? actorId,
        actorAccountId: existing.audit.actorAccountId ?? null,
        signerWallet: existing.signing?.signerWallet ?? null,
        preparedPayloadHash: existing.signing?.preparedPayloadHash ?? null,
        finalSignerWallet: existing.finalSignerWallet ?? null,
        verificationState: existing.verificationState ?? null,
        monitoringState: existing.monitoringState ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const saved = await this.writeStore.saveDirectSignActionWithIntentDedupe(
      record,
      auditEntry,
      duplicateAuditEntry,
      preparedAt,
    );

    const stored = saved.created ? record : (await this.actionStore.get(saved.action.actionId)) ?? saved.action;
    const storedSigning = ensurePreparedSigningPayload(this.config, stored, stored.audit.actorWallet || signerWallet);

    return toPreparedResponse(stored, storedSigning);
  }

  private async verifyBroadcast(
    existing: GovernanceActionRecord,
    txHash: string,
    assertedSignerWallet: string | null,
    expectedSigning: GovernancePreparedSigningPayload,
  ): Promise<GovernanceVerificationOutcome> {
    let observed: GovernanceObservedTransaction | null = null;

    try {
      observed = await this.verifier.getTransaction(txHash);
    } catch {
      observed = null;
    }

    if (!observed) {
      return {
        status: 'broadcast_pending_verification',
        verificationState: 'pending',
        monitoringState: 'pending_verification',
        finalSignerWallet: null,
        verificationError: null,
        verifiedAt: null,
        blockNumber: null,
      };
    }

    const actualChainId = observed.chainId;
    if (actualChainId !== null && actualChainId !== expectedSigning.chainId) {
      throw new GatewayError(409, 'CONFLICT', 'Broadcast transaction chain does not match the prepared governance action', {
        actionId: existing.actionId,
        expectedChainId: expectedSigning.chainId,
        actualChainId,
      });
    }

    const actualTo = normalizeAddressOrNull(observed.to);
    if (!actualTo || actualTo !== expectedSigning.contractAddress) {
      throw new GatewayError(409, 'CONFLICT', 'Broadcast transaction target does not match the prepared governance action', {
        actionId: existing.actionId,
        expectedContractAddress: expectedSigning.contractAddress,
        actualContractAddress: observed.to,
      });
    }

    const actualData = (observed.data ?? '').toLowerCase();
    if (actualData !== expectedSigning.txRequest.data.toLowerCase()) {
      throw new GatewayError(409, 'CONFLICT', 'Broadcast transaction calldata does not match the prepared governance action', {
        actionId: existing.actionId,
      });
    }

    const actualFrom = normalizeAddressOrNull(observed.from);
    if (!actualFrom) {
      throw new GatewayError(409, 'CONFLICT', 'Broadcast transaction signer could not be resolved', {
        actionId: existing.actionId,
      });
    }

    if (actualFrom !== expectedSigning.signerWallet) {
      throw new GatewayError(409, 'CONFLICT', 'Broadcast transaction signer does not match the prepared signer wallet', {
        actionId: existing.actionId,
        expectedSignerWallet: expectedSigning.signerWallet,
        actualSignerWallet: actualFrom,
      });
    }

    if (assertedSignerWallet && actualFrom !== assertedSignerWallet) {
      throw new GatewayError(409, 'CONFLICT', 'Submitted signer wallet does not match the verified broadcast transaction signer', {
        actionId: existing.actionId,
        expectedSignerWallet: assertedSignerWallet,
        actualSignerWallet: actualFrom,
      });
    }

    return {
      status: 'broadcast',
      verificationState: 'verified',
      monitoringState: 'pending_confirmation',
      finalSignerWallet: actualFrom,
      verificationError: null,
      verifiedAt: new Date().toISOString(),
      blockNumber: observed.blockNumber ?? null,
    };
  }

  async confirmBroadcast(input: ConfirmGovernanceBroadcastInput): Promise<GovernanceBroadcastConfirmed> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      throw new GatewayError(400, 'VALIDATION_ERROR', 'txHash must be a 0x-prefixed 32-byte hex string');
    }

    const confirmingWallet = normalizeSignerWallet(requireWalletBoundSession(input.principal, 'Confirming privileged governance broadcast'));
    const assertedSignerWallet = normalizeConfirmedSignerWallet(input.signerWallet);

    const existing = await this.actionStore.get(input.actionId);
    if (!existing) {
      throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found', { actionId: input.actionId });
    }

    if (existing.flowType !== 'direct_sign') {
      throw new GatewayError(409, 'CONFLICT', 'Governance action is not a direct-sign action', {
        actionId: input.actionId,
        flowType: existing.flowType,
      });
    }

    const expectedSigning = ensurePreparedSigningPayload(this.config, existing, existing.audit.actorWallet || confirmingWallet);

    if (confirmingWallet !== expectedSigning.signerWallet) {
      throw new GatewayError(403, 'FORBIDDEN', 'Only the expected prepared signer wallet may confirm broadcast of this action', {
        actionId: input.actionId,
      });
    }

    if (existing.status === 'broadcast') {
      if (existing.txHash && existing.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
        throw new GatewayError(409, 'CONFLICT', 'Governance action has already been confirmed with a different transaction hash', {
          actionId: input.actionId,
          existingTxHash: existing.txHash,
          submittedTxHash: input.txHash,
        });
      }

      return toConfirmedResponse(existing);
    }

    if (existing.status !== 'prepared' && existing.status !== 'broadcast_pending_verification') {
      throw new GatewayError(409, 'CONFLICT', 'Governance action is not in prepared status', {
        actionId: input.actionId,
        status: existing.status,
      });
    }

    if (existing.txHash && existing.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
      throw new GatewayError(409, 'CONFLICT', 'Governance action has already been confirmed with a different transaction hash', {
        actionId: input.actionId,
        existingTxHash: existing.txHash,
        submittedTxHash: input.txHash,
      });
    }

    if (existing.status === 'prepared' && existing.expiresAt && existing.expiresAt <= new Date().toISOString()) {
      throw new GatewayError(409, 'CONFLICT', 'Prepared governance action has expired and must be re-prepared', {
        actionId: input.actionId,
        expiresAt: existing.expiresAt,
      });
    }

    const broadcastAt = existing.broadcastAt ?? new Date().toISOString();
    const actorId = resolveGovernanceActorId(input.principal);
    const verification = await this.verifyBroadcast(existing, input.txHash, assertedSignerWallet, expectedSigning);

    const updatedAction: GovernanceActionRecord = {
      ...existing,
      status: verification.status,
      txHash: input.txHash,
      broadcastAt,
      blockNumber: verification.blockNumber,
      finalSignerWallet: verification.finalSignerWallet ?? existing.finalSignerWallet ?? null,
      verificationState: verification.verificationState,
      verificationError: verification.verificationError,
      verifiedAt: verification.verifiedAt,
      monitoringState: verification.monitoringState,
      signing: expectedSigning,
      audit: {
        ...existing.audit,
        ...((verification.finalSignerWallet ?? existing.finalSignerWallet) ? { finalSignerWallet: verification.finalSignerWallet ?? existing.finalSignerWallet ?? null } : {}),
        ...(verification.verifiedAt ? { finalSignerVerifiedAt: verification.verifiedAt } : {}),
      },
    };

    const auditEntry: AuditLogEntry = {
      eventType: 'governance.action.broadcast_confirmed',
      route: `/governance/actions/${input.actionId}/confirm`,
      method: 'POST',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      actionId: input.actionId,
      actorId,
      actorUserId: input.principal.session.userId,
      actorWalletAddress: input.principal.session.walletAddress,
      actorRole: input.principal.session.role,
      status: updatedAction.status,
      metadata: {
        actionId: input.actionId,
        txHash: input.txHash,
        category: existing.category,
        contractMethod: existing.contractMethod,
        proposalId: existing.proposalId,
        targetAddress: existing.targetAddress,
        flowType: existing.flowType,
        broadcastAt,
        verifiedAt: verification.verifiedAt,
        verificationError: verification.verificationError,
        blockNumber: verification.blockNumber,
        verificationState: verification.verificationState,
        monitoringState: verification.monitoringState,
        expectedSignerWallet: expectedSigning.signerWallet,
        assertedSignerWallet: assertedSignerWallet,
        finalSignerWallet: verification.finalSignerWallet,
        preparedPayloadHash: expectedSigning.preparedPayloadHash,
      },
    };

    const stored = await this.writeStore.saveActionWithAudit(updatedAction, auditEntry);
    return toConfirmedResponse(stored);
  }
}

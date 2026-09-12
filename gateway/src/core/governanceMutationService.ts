/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import type { GatewayConfig } from '../config/env';
import { resolveGovernancePreparationTtlSeconds } from '../config/gatewayConfig';
import type { AuditLogEntry } from './auditLogStore';
import {
  buildGovernanceIntentKey,
  type GovernanceActionRecord,
  type GovernanceActionStore,
} from './governanceStore';
import type {
  ConfirmGovernanceBroadcastInput,
  GovernanceActionPrepared,
  GovernanceBroadcastConfirmed,
  GovernanceTransactionVerifier,
  PrepareGovernanceActionInput,
} from './governanceMutationTypes';
import {
  buildAuditRecord,
  buildGovernanceIntentHash,
  buildSigningPayload,
  assertGovernanceSignerBinding,
  ensurePreparedSigningPayload,
  normalizeAddressOrNull,
  normalizeConfirmedSignerWallet,
  normalizeSignerWallet,
  resolveGovernanceActorId,
  toConfirmedResponse,
  toPreparedResponse,
} from './governanceSigning';
import { createDefaultTransactionVerifier } from './governanceTransactionVerifier';
import { verifyGovernanceBroadcast } from './governanceBroadcastVerification';
import { GatewayError } from '../errors';
import type { GovernanceWriteStore } from './governanceWriteStore';

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

  async prepareAction(input: PrepareGovernanceActionInput): Promise<GovernanceActionPrepared> {
    const signerWallet = normalizeSignerWallet(input.signerWallet);
    assertGovernanceSignerBinding(this.config, signerWallet, input.signerBinding);
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.parse(preparedAt) + resolveGovernancePreparationTtlSeconds(this.config) * 1000,
    ).toISOString();
    const intentKey = buildGovernanceIntentKey({
      category: input.category,
      contractMethod: input.contractMethod,
      proposalId: input.proposalId ?? null,
      targetAddress: input.targetAddress ?? null,
      tradeId: input.tradeId ?? null,
      chainId: this.config.chainId,
      approverWallet: signerWallet,
      signerBindingId: input.signerBinding.bindingId,
    });
    const intentHash = buildGovernanceIntentHash(intentKey);
    const actionId = randomUUID();
    const actorId = resolveGovernanceActorId(input.principal);
    const nonce = await this.verifier.getTransactionCount(signerWallet);
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'RPC returned an invalid signer nonce');
    }
    const signing = buildSigningPayload(
      this.config,
      {
        actionId,
        intentKey,
        actionType: input.category,
        contractMethod: input.contractMethod,
        proposalId: input.proposalId ?? null,
        targetAddress: input.targetAddress ?? null,
        expiresAt,
        auditReference: input.audit.ticketRef,
        nonce,
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
      audit: buildAuditRecord(input.audit, input.principal, preparedAt, input.signerBinding),
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
      actorWalletAddress: normalizeAddressOrNull(input.principal.session.walletAddress),
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
        signerBindingId: input.signerBinding.bindingId,
        signerActionClass: input.signerBinding.actionClass,
        signerEnvironment: input.signerBinding.environment,
        signerPolicyResult: input.signerBinding.policy.result,
        signerPolicyReason: input.signerBinding.policy.reason,
        signerBindingWallet: input.signerBinding.walletAddress,
        breakGlassActive: input.principal.session.breakGlass?.active ?? false,
        breakGlassReason: input.principal.session.breakGlass?.reason ?? null,
        breakGlassExpiresAt: input.principal.session.breakGlass?.expiresAt ?? null,
        breakGlassReviewedAt: input.principal.session.breakGlass?.reviewedAt ?? null,
        breakGlassReviewedBy: input.principal.session.breakGlass?.reviewedBy ?? null,
        breakGlassReviewStatus: input.principal.session.breakGlass?.reviewStatus ?? null,
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
      actorWalletAddress: normalizeAddressOrNull(input.principal.session.walletAddress),
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

    const stored = saved.created
      ? record
      : ((await this.actionStore.get(saved.action.actionId)) ?? saved.action);
    const storedSigning = ensurePreparedSigningPayload(stored);

    return toPreparedResponse(stored, storedSigning);
  }

  async confirmBroadcast(
    input: ConfirmGovernanceBroadcastInput,
  ): Promise<GovernanceBroadcastConfirmed> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'txHash must be a 0x-prefixed 32-byte hex string',
      );
    }

    const confirmingWallet = normalizeSignerWallet(input.signerWallet);
    assertGovernanceSignerBinding(this.config, confirmingWallet, input.signerBinding);
    const assertedSignerWallet = normalizeConfirmedSignerWallet(input.signerWallet);

    const existing = await this.actionStore.get(input.actionId);
    if (!existing) {
      throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found', {
        actionId: input.actionId,
      });
    }

    const expectedSigning = ensurePreparedSigningPayload(existing);

    if (input.signerBinding.bindingId !== existing.audit.signerBindingId) {
      throw new GatewayError(
        403,
        'SIGNER_NOT_AUTHORIZED',
        'Governance confirmation requires the same active signer binding used for preparation',
        { actionId: input.actionId },
      );
    }

    if (confirmingWallet !== expectedSigning.signerWallet) {
      throw new GatewayError(
        403,
        'FORBIDDEN',
        'Only the expected prepared signer wallet may confirm broadcast of this action',
        {
          actionId: input.actionId,
        },
      );
    }

    if (existing.status === 'broadcast') {
      if (existing.txHash && existing.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'Governance action has already been confirmed with a different transaction hash',
          {
            actionId: input.actionId,
            existingTxHash: existing.txHash,
            submittedTxHash: input.txHash,
          },
        );
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
      throw new GatewayError(
        409,
        'CONFLICT',
        'Governance action has already been confirmed with a different transaction hash',
        {
          actionId: input.actionId,
          existingTxHash: existing.txHash,
          submittedTxHash: input.txHash,
        },
      );
    }

    if (
      existing.status === 'prepared' &&
      existing.expiresAt &&
      existing.expiresAt <= new Date().toISOString()
    ) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Prepared governance action has expired and must be re-prepared',
        {
          actionId: input.actionId,
          expiresAt: existing.expiresAt,
        },
      );
    }

    const broadcastAt = existing.broadcastAt ?? new Date().toISOString();
    const actorId = resolveGovernanceActorId(input.principal);
    const verification = await verifyGovernanceBroadcast(
      this.verifier,
      existing,
      input.txHash,
      assertedSignerWallet,
      expectedSigning,
    );

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
        ...((verification.finalSignerWallet ?? existing.finalSignerWallet)
          ? {
              finalSignerWallet:
                verification.finalSignerWallet ?? existing.finalSignerWallet ?? null,
            }
          : {}),
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
      actorWalletAddress: normalizeAddressOrNull(input.principal.session.walletAddress),
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
        assertedSignerWallet,
        finalSignerWallet: verification.finalSignerWallet,
        preparedPayloadHash: expectedSigning.preparedPayloadHash,
        signerBindingId: input.signerBinding.bindingId,
        signerActionClass: input.signerBinding.actionClass,
        signerEnvironment: input.signerBinding.environment,
        signerPolicyResult: input.signerBinding.policy.result,
        signerPolicyReason: input.signerBinding.policy.reason,
        signerBindingWallet: input.signerBinding.walletAddress,
        breakGlassActive: input.principal.session.breakGlass?.active ?? false,
        breakGlassReason: input.principal.session.breakGlass?.reason ?? null,
        breakGlassExpiresAt: input.principal.session.breakGlass?.expiresAt ?? null,
        breakGlassReviewedAt: input.principal.session.breakGlass?.reviewedAt ?? null,
        breakGlassReviewedBy: input.principal.session.breakGlass?.reviewedBy ?? null,
        breakGlassReviewStatus: input.principal.session.breakGlass?.reviewStatus ?? null,
      },
    };

    const stored = await this.writeStore.saveActionWithAudit(updatedAction, auditEntry);
    return toConfirmedResponse(stored);
  }
}

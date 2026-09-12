/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { createPostgresGovernanceActionStore } from '../src/core/governancePostgresStore';
import type { GovernanceActionRecord } from '../src/core/governanceStore';
import { createPostgresGovernanceTransitionStore } from '../src/core/governancePostgresTransitionStore';
import type { GovernanceConfirmationCommit } from '../src/core/governanceTransitionStore';
import type { AuditLogEntry } from '../src/core/auditLogStore';
import { buildSigningPayloadDraft, finalizeSigningPayload } from '../src/core/governanceSigning';
import {
  dockerAvailable,
  withGovernancePostgres as withPostgres,
} from './helpers/governancePostgresHarness';
import { baseTestGatewayConfig } from './support/testConfig';

function buildAction(): GovernanceActionRecord {
  const signer = '0x00000000000000000000000000000000000000AA';
  const contract = '0x00000000000000000000000000000000000000ff';
  const action: GovernanceActionRecord = {
    actionId: 'action-1',
    intentKey: 'v1|pause||||31337|signer',
    intentHash: 'a'.repeat(64),
    proposalId: null,
    category: 'pause',
    status: 'prepared',
    flowType: 'direct_sign',
    contractMethod: 'pause',
    txHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    broadcastAt: null,
    createdAt: '2026-09-12T08:00:00.000Z',
    expiresAt: '2026-09-12T09:00:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    actorId: 'acct-admin-1',
    endpoint: '/governance/pause/prepare',
    errorCode: null,
    errorMessage: null,
    finalSignerWallet: null,
    verificationState: 'not_started',
    verificationError: null,
    verifiedAt: null,
    monitoringState: 'not_started',
    audit: {
      reason: 'Prepare witnessed hardware-wallet governance action.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/COTSEL-641' }],
      ticketRef: 'COTSEL-641',
      actorSessionId: 'sha256:session',
      actorAccountId: 'acct-admin-1',
      actorWallet: signer,
      actorRole: 'admin',
      createdAt: '2026-09-12T08:00:00.000Z',
      requestedBy: 'user-admin-1',
      signerBindingId: 'binding-admin-1',
      signerActionClass: 'governance',
      signerEnvironment: 'staging',
      signerPolicyResult: 'authorized',
      signerBindingWallet: signer,
    },
    signing: null,
  };
  action.signing = finalizeSigningPayload(
    buildSigningPayloadDraft(
      { ...baseTestGatewayConfig, chainId: 31337, escrowAddress: contract },
      {
        actionId: action.actionId,
        intentKey: action.intentKey,
        actionType: action.category,
        contractMethod: action.contractMethod,
        proposalId: action.proposalId,
        targetAddress: action.targetAddress,
        expiresAt: action.expiresAt!,
        auditReference: action.audit.ticketRef,
        nonce: 7,
      },
      signer,
    ),
    {
      chainId: 31337,
      blockNumber: 1,
      blockHash: `0x${'1'.repeat(64)}`,
      simulatedAt: '2026-09-12T08:00:00.000Z',
      providerIdentity: `sha256:${'a'.repeat(64)}`,
      result: 'success',
      returnDataHash: 'b'.repeat(64),
      pointInTimeOnly: true,
    },
  );
  return action;
}

function buildAudit(actionId: string, requestId: string): AuditLogEntry {
  return {
    eventType: 'governance.action.broadcast_confirmed',
    route: `/governance/actions/${actionId}/confirm`,
    method: 'POST',
    requestId,
    actionId,
    actorId: 'acct-admin-1',
    status: 'broadcast',
    metadata: { actionId },
  };
}

function buildConfirmation(
  action: GovernanceActionRecord,
  transactionHash: string,
  requestId: string,
): GovernanceConfirmationCommit {
  return {
    actionId: action.actionId,
    transactionHash,
    signerBindingId: action.audit.signerBindingId!,
    signerWallet: action.signing!.signerWallet,
    preparedPayloadHash: action.signing!.preparedPayloadHash,
    committedAt: '2026-09-12T08:01:00.000Z',
    transition: {
      ...action,
      status: 'broadcast',
      txHash: transactionHash,
      broadcastAt: '2026-09-12T08:01:00.000Z',
      finalSignerWallet: action.signing!.signerWallet,
      verificationState: 'verified',
      verifiedAt: '2026-09-12T08:01:00.000Z',
      monitoringState: 'pending_confirmation',
    },
    auditEntry: buildAudit(action.actionId, requestId),
  };
}

function distinctAction(actionId: string, suffix: string): GovernanceActionRecord {
  const action = buildAction();
  const distinct: GovernanceActionRecord = {
    ...action,
    actionId,
    intentKey: `${action.intentKey}|${suffix}`,
    intentHash: suffix.repeat(64).slice(0, 64),
    idempotencyKey: `idem-${suffix}`,
    signing: null,
  };
  distinct.signing = finalizeSigningPayload(
    buildSigningPayloadDraft(
      { ...baseTestGatewayConfig, chainId: 31337, escrowAddress: action.signing!.contractAddress },
      {
        actionId,
        intentKey: distinct.intentKey,
        actionType: distinct.category,
        contractMethod: distinct.contractMethod,
        proposalId: distinct.proposalId,
        targetAddress: distinct.targetAddress,
        expiresAt: distinct.expiresAt!,
        auditReference: distinct.audit.ticketRef,
        nonce: 7,
      },
      action.signing!.signerWallet,
    ),
    action.signing!.simulation,
  );
  return distinct;
}

describe('governance direct-sign migration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'enforces service isolation, immutable intent, immutable tx hash and terminal states',
    async () => {
      await withPostgres(async (port) => {
        const connection = {
          host: '127.0.0.1',
          port,
          database: 'gateway_test',
          user: 'gateway_runtime',
          password: 'gateway-runtime-test',
        };
        const pool = new Pool({ ...connection, options: '-c app.service_name=gateway' });
        const wrongService = new Pool({ ...connection, options: '-c app.service_name=auth' });
        try {
          const store = createPostgresGovernanceActionStore(pool);
          const prepared = buildAction();
          await expect(store.save(prepared)).resolves.toMatchObject({
            status: 'prepared',
            audit: {
              signerBindingId: 'binding-admin-1',
              signerActionClass: 'governance',
              signerEnvironment: 'staging',
              signerPolicyResult: 'authorized',
              signerBindingWallet: prepared.signing!.signerWallet,
            },
          });

          await expect(
            store.save({
              ...prepared,
              signing: { ...prepared.signing!, auditReference: 'ATTACK-1' },
            }),
          ).rejects.toThrow('intent and audit evidence are immutable');

          const txHash = `0x${'1'.repeat(64)}`;
          const broadcast = {
            ...prepared,
            status: 'broadcast' as const,
            txHash,
            broadcastAt: '2026-09-12T08:01:00.000Z',
            finalSignerWallet: prepared.signing!.signerWallet,
            verificationState: 'verified' as const,
            verifiedAt: '2026-09-12T08:01:00.000Z',
            monitoringState: 'pending_confirmation' as const,
          };
          await expect(store.save(broadcast)).resolves.toMatchObject({ txHash });
          await expect(store.save({ ...broadcast, txHash: `0x${'2'.repeat(64)}` })).rejects.toThrow(
            'transaction hash is immutable',
          );

          const executed = {
            ...broadcast,
            status: 'executed' as const,
            monitoringState: 'finalized' as const,
            executedAt: '2026-09-12T08:05:00.000Z',
          };
          await expect(store.save(executed)).resolves.toMatchObject({ status: 'executed' });
          await expect(store.save({ ...executed, status: 'failed' as const })).rejects.toThrow(
            'terminal governance action status is immutable',
          );

          const hidden = await wrongService.query('SELECT * FROM governance_actions');
          expect(hidden.rows).toEqual([]);

          const wrongServiceStore = createPostgresGovernanceActionStore(wrongService);
          const unauthorized = {
            ...prepared,
            actionId: 'action-wrong-service',
            intentKey: 'v1|pause||||31337|wrong-service',
            signing: {
              ...prepared.signing!,
              actionId: 'action-wrong-service',
              intentKey: 'v1|pause||||31337|wrong-service',
            },
          };
          await expect(wrongServiceStore.save(unauthorized)).rejects.toThrow(
            'row-level security policy',
          );
        } finally {
          await pool.end();
          await wrongService.end();
        }
      });
    },
    120_000,
  );

  integrationTest(
    'serializes confirmations and enforces one normalized transaction hash per action cohort',
    async () => {
      await withPostgres(async (port) => {
        const connection = {
          host: '127.0.0.1',
          port,
          database: 'gateway_test',
          user: 'gateway_runtime',
          password: 'gateway-runtime-test',
          options: '-c app.service_name=gateway',
        };
        const poolA = new Pool(connection);
        const poolB = new Pool(connection);
        try {
          const actionStore = createPostgresGovernanceActionStore(poolA);
          const transitionA = createPostgresGovernanceTransitionStore(poolA);
          const transitionB = createPostgresGovernanceTransitionStore(poolB);
          const first = buildAction();
          await actionStore.save(first);

          const sameHash = `0x${'1'.repeat(64)}`;
          const sameResults = await Promise.all([
            transitionA.commitConfirmation(buildConfirmation(first, sameHash, 'confirm-a')),
            transitionB.commitConfirmation(buildConfirmation(first, sameHash, 'confirm-b')),
          ]);
          expect(sameResults.map((result) => result.txHash)).toEqual([sameHash, sameHash]);
          const sameAudit = await poolA.query(
            `SELECT COUNT(*)::int AS count FROM audit_log
             WHERE event_type = 'governance.action.broadcast_confirmed'`,
          );
          expect(sameAudit.rows[0]?.count).toBe(1);
          const competing = distinctAction('action-competing', 'c');
          await actionStore.save(competing);
          const competingResults = await Promise.allSettled([
            transitionA.commitConfirmation(
              buildConfirmation(competing, `0x${'2'.repeat(64)}`, 'competing-a'),
            ),
            transitionB.commitConfirmation(
              buildConfirmation(competing, `0x${'3'.repeat(64)}`, 'competing-b'),
            ),
          ]);
          expect(competingResults.filter((result) => result.status === 'fulfilled')).toHaveLength(
            1,
          );
          expect(competingResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
          const sharedHash = `0x${'a'.repeat(64)}`;
          const sharedHashUpper = `0x${'A'.repeat(64)}`;
          const left = distinctAction('action-left', 'd');
          const right = distinctAction('action-right', 'e');
          await actionStore.save(left);
          await actionStore.save(right);
          const sharedResults = await Promise.allSettled([
            transitionA.commitConfirmation(buildConfirmation(left, sharedHash, 'shared-left')),
            transitionB.commitConfirmation(
              buildConfirmation(right, sharedHashUpper, 'shared-right'),
            ),
          ]);
          expect(sharedResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          expect(sharedResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
        } finally {
          await poolA.end();
          await poolB.end();
        }
      });
    },
    120_000,
  );

  integrationTest(
    'allows one monitor replica to claim an action and rejects a stale worker result',
    async () => {
      await withPostgres(async (port) => {
        const connection = {
          host: '127.0.0.1',
          port,
          database: 'gateway_test',
          user: 'gateway_runtime',
          password: 'gateway-runtime-test',
          options: '-c app.service_name=gateway',
        };
        const poolA = new Pool(connection);
        const poolB = new Pool(connection);
        try {
          const actionStore = createPostgresGovernanceActionStore(poolA);
          const prepared = buildAction();
          const broadcast = buildConfirmation(
            prepared,
            `0x${'5'.repeat(64)}`,
            'monitor-setup',
          ).transition;
          await actionStore.save(broadcast);
          const monitorA = createPostgresGovernanceTransitionStore(poolA);
          const monitorB = createPostgresGovernanceTransitionStore(poolB);

          const simultaneous = await Promise.all([
            monitorA.claimMonitorActions({
              workerId: 'replica-a',
              claimedAt: '2026-09-12T08:02:00.000Z',
              leaseExpiresAt: '2026-09-12T08:03:00.000Z',
              limit: 1,
            }),
            monitorB.claimMonitorActions({
              workerId: 'replica-b',
              claimedAt: '2026-09-12T08:02:00.000Z',
              leaseExpiresAt: '2026-09-12T08:03:00.000Z',
              limit: 1,
            }),
          ]);
          expect(simultaneous.flat()).toHaveLength(1);
          const staleClaim = simultaneous.flat()[0]!;

          const replacement = await monitorB.claimMonitorActions({
            workerId: 'replica-replacement',
            claimedAt: '2026-09-12T08:03:00.000Z',
            leaseExpiresAt: '2026-09-12T08:04:00.000Z',
            limit: 1,
          });
          expect(replacement).toHaveLength(1);
          const finalized = {
            ...replacement[0]!.action,
            status: 'executed' as const,
            monitoringState: 'finalized' as const,
            executedAt: '2026-09-12T08:03:10.000Z',
          };
          await expect(
            monitorA.completeMonitorClaim(
              staleClaim,
              { ...staleClaim.action, status: 'failed', monitoringState: 'reverted' },
              buildAudit(staleClaim.action.actionId, 'stale-worker'),
              '2026-09-12T08:03:01.000Z',
            ),
          ).resolves.toBeNull();
          await expect(
            monitorB.completeMonitorClaim(
              replacement[0]!,
              finalized,
              buildAudit(finalized.actionId, 'replacement-worker'),
              '2026-09-12T08:03:10.000Z',
            ),
          ).resolves.toMatchObject({ status: 'executed', monitoringState: 'finalized' });
          await expect(actionStore.get(prepared.actionId)).resolves.toMatchObject({
            status: 'executed',
            monitoringState: 'finalized',
          });
        } finally {
          await poolA.end();
          await poolB.end();
        }
      });
    },
    120_000,
  );
});

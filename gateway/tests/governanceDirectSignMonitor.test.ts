/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress } from 'ethers';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { GovernanceDirectSignMonitor } from '../src/core/governanceDirectSignMonitor';
import type {
  GovernanceObservedTransaction,
  GovernanceObservedTransactionReceipt,
  GovernanceTransactionVerifier,
} from '../src/core/governanceMutationService';
import {
  buildGovernanceIntentKey,
  createInMemoryGovernanceActionStore,
  type GovernanceActionRecord,
  type GovernancePreparedSigningPayload,
} from '../src/core/governanceStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';

function buildSigningPayload(): GovernancePreparedSigningPayload {
  return {
    chainId: 31337,
    contractAddress: getAddress('0x00000000000000000000000000000000000000ff'),
    contractMethod: 'pause',
    args: [],
    txRequest: {
      chainId: 31337,
      to: getAddress('0x00000000000000000000000000000000000000ff'),
      data: '0x8456cb59',
      value: '0',
    },
    signerWallet: getAddress('0x00000000000000000000000000000000000000aa'),
    preparedPayloadHash: 'a'.repeat(64),
  };
}

function buildAction(overrides: Partial<GovernanceActionRecord> = {}): GovernanceActionRecord {
  const signing = buildSigningPayload();
  return {
    actionId: 'action-1',
    intentKey: buildGovernanceIntentKey({
      category: 'pause',
      contractMethod: 'pause',
      chainId: '31337',
      approverWallet: signing.signerWallet,
    }),
    proposalId: null,
    category: 'pause',
    status: 'broadcast_pending_verification',
    flowType: 'direct_sign',
    contractMethod: 'pause',
    txHash: `0x${'1'.repeat(64)}`,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    broadcastAt: '2026-04-07T10:00:00.000Z',
    createdAt: '2026-04-07T09:59:00.000Z',
    expiresAt: '2026-04-08T09:59:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    signing,
    finalSignerWallet: null,
    verificationState: 'pending',
    verificationError: null,
    verifiedAt: null,
    monitoringState: 'pending_verification',
    audit: {
      reason: 'Direct-sign privileged governance approval.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-800' }],
      ticketRef: 'AGRO-800',
      actorSessionId: 'sess-admin',
      actorAccountId: 'acct-admin',
      actorWallet: signing.signerWallet,
      actorRole: 'admin',
      createdAt: '2026-04-07T09:59:00.000Z',
      requestedBy: 'uid-admin',
    },
    ...overrides,
  };
}

function buildObservedTransaction(
  overrides: Partial<GovernanceObservedTransaction> = {},
): GovernanceObservedTransaction {
  const signing = buildSigningPayload();
  return {
    chainId: signing.chainId,
    to: signing.contractAddress,
    from: signing.signerWallet,
    data: signing.txRequest.data,
    blockNumber: 88,
    ...overrides,
  };
}

function buildReceipt(
  overrides: Partial<GovernanceObservedTransactionReceipt> = {},
): GovernanceObservedTransactionReceipt {
  return {
    blockNumber: 88,
    status: 'success',
    ...overrides,
  };
}

function createVerifier(
  overrides: Partial<GovernanceTransactionVerifier> = {},
): GovernanceTransactionVerifier {
  return {
    getTransaction: jest.fn(async () => null),
    getTransactionReceipt: jest.fn(async () => null),
    getBlockNumber: jest.fn(async () => null),
    ...overrides,
  };
}

describe('GovernanceDirectSignMonitor', () => {
  test('verifies a previously unobserved tx and moves it into pending confirmation monitoring', async () => {
    const store = createInMemoryGovernanceActionStore([buildAction()]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransaction: jest.fn(async () => buildObservedTransaction({ blockNumber: 91 })),
    });
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      { now: () => new Date('2026-04-07T10:01:00.000Z') },
    );

    const result = await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(result.updatedCount).toBe(1);
    expect(updated?.status).toBe('broadcast');
    expect(updated?.verificationState).toBe('verified');
    expect(updated?.monitoringState).toBe('pending_confirmation');
    expect(updated?.finalSignerWallet).toBe(buildSigningPayload().signerWallet);
    expect(updated?.blockNumber).toBe(91);
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.verified');
  });

  test('marks a direct-sign action confirmed once the receipt is mined', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        status: 'broadcast',
        monitoringState: 'pending_confirmation',
        verificationState: 'verified',
        finalSignerWallet: buildSigningPayload().signerWallet,
        verifiedAt: '2026-04-07T10:00:10.000Z',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransactionReceipt: jest.fn(async () => buildReceipt({ blockNumber: 88 })),
      getBlockNumber: jest.fn(async () => 88),
    });
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      {
        now: () => new Date('2026-04-07T10:02:00.000Z'),
        confirmationDepth: 1,
        finalizationDepth: 5,
      },
    );

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('broadcast');
    expect(updated?.monitoringState).toBe('confirmed');
    expect(updated?.blockNumber).toBe(88);
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.confirmed');
  });

  test('finalizes a confirmed action after sufficient block depth', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        status: 'broadcast',
        monitoringState: 'confirmed',
        verificationState: 'verified',
        finalSignerWallet: buildSigningPayload().signerWallet,
        verifiedAt: '2026-04-07T10:00:10.000Z',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransactionReceipt: jest.fn(async () => buildReceipt({ blockNumber: 88 })),
      getBlockNumber: jest.fn(async () => 92),
    });
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      {
        now: () => new Date('2026-04-07T10:05:00.000Z'),
        confirmationDepth: 1,
        finalizationDepth: 5,
      },
    );

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('executed');
    expect(updated?.monitoringState).toBe('finalized');
    expect(updated?.executedAt).toBe('2026-04-07T10:05:00.000Z');
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.finalized');
  });

  test('marks the action reverted when the observed receipt fails on-chain', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        status: 'broadcast',
        monitoringState: 'pending_confirmation',
        verificationState: 'verified',
        finalSignerWallet: buildSigningPayload().signerWallet,
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransactionReceipt: jest.fn(async () =>
        buildReceipt({ blockNumber: 90, status: 'reverted' }),
      ),
      getBlockNumber: jest.fn(async () => 90),
    });
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      { now: () => new Date('2026-04-07T10:03:00.000Z') },
    );

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('failed');
    expect(updated?.monitoringState).toBe('reverted');
    expect(updated?.errorCode).toBe('TX_REVERTED');
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.reverted');
  });

  test('marks verification-pending actions stale when they remain unobserved too long', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        broadcastAt: '2026-04-07T10:00:00.000Z',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier();
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      {
        now: () => new Date('2026-04-07T10:30:00.000Z'),
        pendingVerificationStaleAfterMs: 60_000,
      },
    );

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('stale');
    expect(updated?.monitoringState).toBe('stale');
    expect(updated?.errorCode).toBe('TX_NOT_OBSERVED');
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.stale');
  });

  test('marks verification as failed when the observed tx does not match the prepared payload', async () => {
    const store = createInMemoryGovernanceActionStore([buildAction()]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransaction: jest.fn(async () => buildObservedTransaction({ data: '0xdeadbeef' })),
    });
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      { now: () => new Date('2026-04-07T10:01:00.000Z') },
    );

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('failed');
    expect(updated?.verificationState).toBe('failed');
    expect(updated?.monitoringState).toBe('pending_verification');
    expect(updated?.errorCode).toBe('BROADCAST_VERIFICATION_FAILED');
    expect(auditLogStore.entries[0]?.eventType).toBe(
      'governance.action.monitoring.verification_failed',
    );
  });

  test('ignores executor-flow actions even if they share a broadcast status', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-executor',
        flowType: 'executor',
        status: 'broadcast',
        monitoringState: 'pending_confirmation',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransactionReceipt: jest.fn(async () => buildReceipt()),
      getBlockNumber: jest.fn(async () => 99),
    });
    const service = new GovernanceDirectSignMonitor(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      verifier,
      { now: () => new Date('2026-04-07T10:10:00.000Z') },
    );

    const result = await service.processPendingActions();
    const updated = await store.get('action-executor');

    expect(result.updatedCount).toBe(0);
    expect(updated?.status).toBe('broadcast');
    expect(auditLogStore.entries).toHaveLength(0);
  });
});

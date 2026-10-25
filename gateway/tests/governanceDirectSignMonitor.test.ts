/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress } from 'ethers';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { GovernanceDirectSignMonitor } from '../src/core/governanceDirectSignMonitor';
import type { TransactionFinalityObservation } from '@agroasys/sdk';
import type {
  GovernanceObservedTransaction,
  GovernanceTransactionVerifier,
} from '../src/core/governanceMutationTypes';
import {
  buildGovernanceIntentKey,
  type GovernanceActionRecord,
  type GovernancePreparedSigningPayload,
} from '../src/core/governanceStore';
import { createInMemoryGovernanceActionStore } from '../src/core/governanceInMemoryStore';
import { createInMemoryGovernanceTransitionStore } from '../src/core/governanceTransitionStore';

function createMonitor(
  store: ReturnType<typeof createInMemoryGovernanceActionStore>,
  auditLogStore: ReturnType<typeof createInMemoryAuditLogStore>,
  verifier: GovernanceTransactionVerifier,
  options: ConstructorParameters<typeof GovernanceDirectSignMonitor>[2] = {},
): GovernanceDirectSignMonitor {
  return new GovernanceDirectSignMonitor(
    createInMemoryGovernanceTransitionStore(store, auditLogStore),
    verifier,
    options,
  );
}

function buildSigningPayload(): GovernancePreparedSigningPayload {
  const signerWallet = getAddress('0x00000000000000000000000000000000000000aa');
  const intentKey = buildGovernanceIntentKey({
    category: 'pause',
    contractMethod: 'pause',
    chainId: '31337',
    approverWallet: signerWallet,
  });
  return {
    actionId: 'action-1',
    intentKey,
    actionType: 'pause',
    proposalId: null,
    expiresAt: '2026-04-08T09:59:00.000Z',
    auditReference: 'AGRO-800',
    chainId: 31337,
    contractAddress: getAddress('0x00000000000000000000000000000000000000ff'),
    contractMethod: 'pause',
    args: [],
    txRequest: {
      chainId: 31337,
      from: signerWallet,
      to: getAddress('0x00000000000000000000000000000000000000ff'),
      data: '0x8456cb59',
      value: '0',
      nonce: 7,
    },
    signerWallet,
    simulation: {
      chainId: 31337,
      blockNumber: 87,
      blockHash: `0x${'8'.repeat(64)}`,
      simulatedAt: '2026-04-07T09:59:00.000Z',
      providerIdentity: `sha256:${'a'.repeat(64)}`,
      result: 'success',
      returnDataHash: 'b'.repeat(64),
      pointInTimeOnly: true,
    },
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
    value: '0',
    nonce: signing.txRequest.nonce,
    blockNumber: 88,
    ...overrides,
  };
}

const RECEIPT_BLOCK_HASH = `0x${'a'.repeat(64)}`;

function buildFinalityObservation(
  overrides: Partial<TransactionFinalityObservation> = {},
): TransactionFinalityObservation {
  return {
    providerId: 'sha256:provider',
    chainId: 31337,
    latestBlockNumber: 88,
    safeBlockNumber: 80,
    finalizedBlockNumber: 70,
    receipt: { blockNumber: 88, blockHash: RECEIPT_BLOCK_HASH, status: 1 },
    canonicalBlockHash: RECEIPT_BLOCK_HASH,
    ...overrides,
  };
}

function createVerifier(
  overrides: Partial<GovernanceTransactionVerifier> = {},
): GovernanceTransactionVerifier {
  return {
    getTransactionCount: jest.fn(async () => 7),
    simulateTransaction: jest.fn(async () => buildSigningPayload().simulation),
    getTransaction: jest.fn(async () => null),
    getTransactionReceipt: jest.fn(async () => null),
    getBlockNumber: jest.fn(async () => null),
    observeTransactionFinality: jest.fn(async () =>
      buildFinalityObservation({ receipt: null, canonicalBlockHash: null }),
    ),
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
    const service = createMonitor(store, auditLogStore, verifier, {
      now: () => new Date('2026-04-07T10:01:00.000Z'),
    });

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

  test('upgrades a late hash report only after the transaction is observed', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        errorCode: 'LATE_BROADCAST_REPORTED',
        errorMessage: 'Transaction hash was reported after preparation expiry',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransaction: jest.fn(async () => buildObservedTransaction({ blockNumber: 91 })),
    });
    const service = createMonitor(store, auditLogStore, verifier, {
      now: () => new Date('2026-04-07T10:01:00.000Z'),
    });

    await service.processPendingActions();
    await expect(store.get('action-1')).resolves.toMatchObject({
      errorCode: 'LATE_BROADCAST_DETECTED',
      errorMessage: 'Transaction was observed after the off-chain preparation policy expired',
    });
  });

  function confirmingAction(overrides: Partial<GovernanceActionRecord> = {}) {
    return buildAction({
      status: 'broadcast',
      monitoringState: 'pending_confirmation',
      verificationState: 'verified',
      finalSignerWallet: buildSigningPayload().signerWallet,
      verifiedAt: '2026-04-07T10:00:10.000Z',
      ...overrides,
    });
  }

  async function monitorWith(
    action: GovernanceActionRecord,
    observation: TransactionFinalityObservation,
    now = '2026-04-07T10:02:00.000Z',
  ) {
    const store = createInMemoryGovernanceActionStore([action]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      observeTransactionFinality: jest.fn(async () => observation),
    });
    const result = await createMonitor(store, auditLogStore, verifier, {
      now: () => new Date(now),
    }).processPendingActions();
    return { result, updated: await store.get('action-1'), auditLogStore };
  }

  test('marks a direct-sign action confirmed once the receipt is mined', async () => {
    const { updated, auditLogStore } = await monitorWith(
      confirmingAction(),
      buildFinalityObservation(),
    );

    expect(updated?.status).toBe('broadcast');
    expect(updated?.monitoringState).toBe('confirmed');
    expect(updated?.blockNumber).toBe(88);
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.confirmed');
    expect(auditLogStore.entries[0]?.metadata).toMatchObject({
      finalityModelVersion: 'cotsel.transaction-finality.v1',
      finalityState: 'confirmed',
      finalityReason: 'included',
    });
  });

  test('never finalizes from block depth while the finalized tag is behind the receipt', async () => {
    const { updated, result } = await monitorWith(
      confirmingAction({ monitoringState: 'confirmed', blockNumber: 88 }),
      buildFinalityObservation({
        latestBlockNumber: 10_000,
        safeBlockNumber: 9_990,
        finalizedBlockNumber: 87,
      }),
    );

    expect(result.updatedCount).toBe(0);
    expect(updated?.status).toBe('broadcast');
    expect(updated?.monitoringState).toBe('confirmed');
    expect(updated?.executedAt).toBeNull();
  });

  test('never finalizes when the provider does not support the finalized tag', async () => {
    const { updated } = await monitorWith(
      confirmingAction(),
      buildFinalityObservation({
        latestBlockNumber: 10_000,
        safeBlockNumber: 'unsupported',
        finalizedBlockNumber: 'unsupported',
      }),
    );

    expect(updated?.status).toBe('broadcast');
    expect(updated?.monitoringState).toBe('confirmed');
  });

  test('finalizes a confirmed action once the finalized tag covers its block', async () => {
    const { updated, auditLogStore } = await monitorWith(
      confirmingAction({ monitoringState: 'confirmed' }),
      buildFinalityObservation({
        latestBlockNumber: 120,
        safeBlockNumber: 100,
        finalizedBlockNumber: 88,
      }),
      '2026-04-07T10:05:00.000Z',
    );

    expect(updated?.status).toBe('executed');
    expect(updated?.monitoringState).toBe('finalized');
    expect(updated?.executedAt).toBe('2026-04-07T10:05:00.000Z');
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.finalized');
  });

  test('returns a confirmed action to unresolved when its receipt block is reorganized away', async () => {
    const { updated, result, auditLogStore } = await monitorWith(
      confirmingAction({ monitoringState: 'confirmed', blockNumber: 88 }),
      buildFinalityObservation({
        latestBlockNumber: 120,
        finalizedBlockNumber: 100,
        safeBlockNumber: 110,
        canonicalBlockHash: `0x${'b'.repeat(64)}`,
      }),
    );

    expect(result.updatedCount).toBe(1);
    expect(updated).toMatchObject({
      status: 'broadcast',
      monitoringState: 'pending_confirmation',
      blockNumber: null,
      executedAt: null,
      errorCode: 'TX_RECEIPT_NOT_CANONICAL',
    });
    expect(auditLogStore.entries[0]?.eventType).toBe(
      'governance.action.monitoring.canonicality_lost',
    );
    expect(auditLogStore.entries[0]?.metadata).toMatchObject({
      previousMonitoringState: 'confirmed',
      previousBlockNumber: 88,
      finalityState: 'unknown',
      finalityReason: 'receipt_not_canonical',
    });
  });

  test('keeps polling a reorganized action past the stale window and re-confirms it', async () => {
    const store = createInMemoryGovernanceActionStore([
      confirmingAction({
        monitoringState: 'confirmed',
        blockNumber: 88,
        broadcastAt: '2026-04-07T10:00:00.000Z',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const observe = jest.fn(async () =>
      buildFinalityObservation({ canonicalBlockHash: `0x${'b'.repeat(64)}` }),
    );
    const monitor = createMonitor(
      store,
      auditLogStore,
      createVerifier({ observeTransactionFinality: observe }),
      { now: () => new Date('2026-04-07T11:00:00.000Z') },
    );

    await monitor.processPendingActions();
    await monitor.processPendingActions();
    await expect(store.get('action-1')).resolves.toMatchObject({
      status: 'broadcast',
      monitoringState: 'pending_confirmation',
    });
    expect(auditLogStore.entries).toHaveLength(1);

    observe.mockResolvedValue(
      buildFinalityObservation({
        receipt: { blockNumber: 89, blockHash: RECEIPT_BLOCK_HASH, status: 1 },
        latestBlockNumber: 89,
      }),
    );
    await monitor.processPendingActions();
    await expect(store.get('action-1')).resolves.toMatchObject({
      status: 'broadcast',
      monitoringState: 'confirmed',
      blockNumber: 89,
      errorCode: null,
    });
  });

  test('ignores finality observed on a different chain', async () => {
    const { updated, result } = await monitorWith(
      confirmingAction(),
      buildFinalityObservation({ chainId: 1, finalizedBlockNumber: 88, safeBlockNumber: 88 }),
    );

    expect(result.updatedCount).toBe(0);
    expect(updated?.monitoringState).toBe('pending_confirmation');
  });

  test('keeps monitoring an unfinalized revert instead of failing the action', async () => {
    const { updated, auditLogStore } = await monitorWith(
      confirmingAction(),
      buildFinalityObservation({
        receipt: { blockNumber: 88, blockHash: RECEIPT_BLOCK_HASH, status: 0 },
      }),
    );

    expect(updated?.status).toBe('broadcast');
    expect(updated?.monitoringState).toBe('reverted');
    expect(updated?.errorCode).toBeNull();
    expect(auditLogStore.entries[0]?.eventType).toBe(
      'governance.action.monitoring.reverted_unfinalized',
    );
  });

  test('marks the action failed once its revert is finalized', async () => {
    const { updated, auditLogStore } = await monitorWith(
      confirmingAction({ monitoringState: 'reverted' }),
      buildFinalityObservation({
        latestBlockNumber: 100,
        safeBlockNumber: 95,
        finalizedBlockNumber: 90,
        receipt: { blockNumber: 88, blockHash: RECEIPT_BLOCK_HASH, status: 0 },
      }),
      '2026-04-07T10:03:00.000Z',
    );

    expect(updated?.status).toBe('failed');
    expect(updated?.monitoringState).toBe('reverted');
    expect(updated?.errorCode).toBe('TX_REVERTED');
    expect(updated?.executedAt).toBeNull();
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.reverted');
  });

  test('marks a confirmation stale when no canonical receipt appears within the window', async () => {
    const { updated } = await monitorWith(
      confirmingAction({ broadcastAt: '2026-04-07T10:00:00.000Z' }),
      buildFinalityObservation({ receipt: null, canonicalBlockHash: null }),
      '2026-04-07T11:00:00.000Z',
    );

    expect(updated?.status).toBe('stale');
    expect(updated?.errorCode).toBe('TX_CONFIRMATION_STALE');
    expect(updated?.errorMessage).toContain('finality: submitted/awaiting_receipt');
  });

  test('marks verification-pending actions stale when they remain unobserved too long', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        broadcastAt: '2026-04-07T10:00:00.000Z',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier();
    const service = createMonitor(store, auditLogStore, verifier, {
      now: () => new Date('2026-04-07T10:30:00.000Z'),
      pendingVerificationStaleAfterMs: 60_000,
    });

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('stale');
    expect(updated?.monitoringState).toBe('stale');
    expect(updated?.errorCode).toBe('TX_NOT_OBSERVED');
    expect(updated?.executedAt).toBeNull();
    expect(auditLogStore.entries[0]?.eventType).toBe('governance.action.monitoring.stale');
  });

  test('marks verification as failed when the observed tx does not match the prepared payload', async () => {
    const store = createInMemoryGovernanceActionStore([buildAction()]);
    const auditLogStore = createInMemoryAuditLogStore();
    const verifier = createVerifier({
      getTransaction: jest.fn(async () => buildObservedTransaction({ data: '0xdeadbeef' })),
    });
    const service = createMonitor(store, auditLogStore, verifier, {
      now: () => new Date('2026-04-07T10:01:00.000Z'),
    });

    await service.processPendingActions();
    const updated = await store.get('action-1');

    expect(updated?.status).toBe('failed');
    expect(updated?.verificationState).toBe('failed');
    expect(updated?.monitoringState).toBe('pending_verification');
    expect(updated?.errorCode).toBe('BROADCAST_VERIFICATION_FAILED');
    expect(updated?.executedAt).toBeNull();
    expect(auditLogStore.entries[0]?.eventType).toBe(
      'governance.action.monitoring.verification_failed',
    );
  });
});

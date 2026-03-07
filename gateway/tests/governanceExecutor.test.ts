/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import {
  createInMemoryGovernanceActionStore,
  GovernanceActionRecord,
} from '../src/core/governanceStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';
import {
  createInMemoryGovernanceExecutionLock,
  GovernanceChainExecutor,
  GovernanceExecutorService,
} from '../src/executor/governanceExecutor';
import {
  GovernanceMutationPreflightReader,
  GovernanceProposalState,
  GovernanceStatusSnapshot,
  UnpauseProposalState,
} from '../src/core/governanceStatusService';

function buildStatusSnapshot(overrides: Partial<GovernanceStatusSnapshot> = {}): GovernanceStatusSnapshot {
  return {
    paused: true,
    claimsPaused: false,
    oracleActive: true,
    oracleAddress: '0x0000000000000000000000000000000000000011',
    treasuryAddress: '0x0000000000000000000000000000000000000022',
    treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
    governanceApprovalsRequired: 2,
    governanceTimelockSeconds: 86400,
    requiredAdminCount: 2,
    hasActiveUnpauseProposal: true,
    activeUnpauseApprovals: 1,
    activeOracleProposalIds: [7],
    activeTreasuryPayoutReceiverProposalIds: [8],
    ...overrides,
  };
}

function buildProposalState(overrides: Partial<GovernanceProposalState> = {}): GovernanceProposalState {
  return {
    proposalId: 7,
    approvalCount: 2,
    executed: false,
    cancelled: false,
    expired: false,
    etaSeconds: Math.floor(Date.now() / 1000) - 10,
    targetAddress: '0x0000000000000000000000000000000000000044',
    ...overrides,
  };
}

function buildUnpauseProposal(overrides: Partial<UnpauseProposalState> = {}): UnpauseProposalState {
  return {
    hasActiveProposal: false,
    approvalCount: 2,
    executed: true,
    ...overrides,
  };
}

function buildAction(overrides: Partial<GovernanceActionRecord> = {}): GovernanceActionRecord {
  return {
    actionId: 'action-1',
    proposalId: null,
    category: 'pause',
    status: 'requested',
    contractMethod: 'pause',
    txHash: null,
    extrinsicHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    createdAt: '2026-03-07T10:00:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    audit: {
      reason: 'Queue governance action for enterprise operator workflow.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-321' }],
      ticketRef: 'AGRO-321',
      actorSessionId: 'sess-admin',
      actorWallet: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      createdAt: '2026-03-07T10:00:00.000Z',
      requestedBy: 'uid-admin',
    },
    ...overrides,
  };
}

function createReader(overrides: Partial<jest.Mocked<GovernanceMutationPreflightReader>> = {}): jest.Mocked<GovernanceMutationPreflightReader> {
  return {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot()),
    getUnpauseProposalState: jest.fn().mockResolvedValue(buildUnpauseProposal()),
    getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState()),
    getTreasuryPayoutReceiverProposalState: jest.fn().mockResolvedValue(buildProposalState({ proposalId: 8 })),
    getTreasuryClaimableBalance: jest.fn().mockResolvedValue(10n),
    hasApprovedUnpause: jest.fn().mockResolvedValue(false),
    hasApprovedOracleProposal: jest.fn().mockResolvedValue(false),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function createExecutor(
  overrides: Partial<GovernanceChainExecutor & {
    getSignerAddress: jest.Mock;
    execute: jest.Mock;
  }> = {},
): GovernanceChainExecutor & {
  getSignerAddress: jest.Mock;
  execute: jest.Mock;
} {
  return {
    getSignerAddress: jest.fn(async () => '0x0000000000000000000000000000000000000e11'),
    execute: jest.fn(async () => ({
      txHash: '0xabc123',
      blockNumber: 88,
    })),
    ...overrides,
  };
}

describe('GovernanceExecutorService', () => {
  test('executes a direct governance action and persists the result', async () => {
    const store = createInMemoryGovernanceActionStore([buildAction()]);
    const auditLogStore = createInMemoryAuditLogStore();
    const reader = createReader();
    const executor = createExecutor();
    const service = new GovernanceExecutorService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      reader,
      createInMemoryGovernanceExecutionLock(),
      executor,
    );

    const result = await service.executeAction('action-1', 'executor-req-1', 'executor-corr-1');

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('executed');
    expect(result.txHash).toBe('0xabc123');
    expect(result.blockNumber).toBe(88);
    expect(result.executedAt).toBeTruthy();
    expect(auditLogStore.entries).toHaveLength(2);
    expect(auditLogStore.entries[0].eventType).toBe('governance.action.execution.started');
    expect(auditLogStore.entries[1].eventType).toBe('governance.action.execution.succeeded');
  });

  test('stores returned proposal ids for proposal-creation actions', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-propose-oracle',
        category: 'oracle_update',
        contractMethod: 'proposeOracleUpdate',
        targetAddress: '0x00000000000000000000000000000000000000f1',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceExecutorService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      createReader(),
      createInMemoryGovernanceExecutionLock(),
      createExecutor({
        execute: jest.fn().mockResolvedValue({
          txHash: '0xdef456',
          blockNumber: 99,
          proposalId: 12,
        }),
      }),
    );

    const result = await service.executeAction('action-propose-oracle', 'executor-req-2');

    expect(result.status).toBe('pending_approvals');
    expect(result.proposalId).toBe(12);
    expect(result.txHash).toBe('0xdef456');
  });

  test('resolves approval actions to approved when quorum is met', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-approve-oracle',
        proposalId: 7,
        category: 'oracle_update',
        contractMethod: 'approveOracleUpdate',
        targetAddress: '0x0000000000000000000000000000000000000044',
      }),
    ]);
    const reader = createReader({
      getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot({ governanceApprovalsRequired: 2 })),
      getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState({
        proposalId: 7,
        approvalCount: 2,
        executed: false,
        cancelled: false,
        expired: false,
      })),
    });
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceExecutorService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      reader,
      createInMemoryGovernanceExecutionLock(),
      createExecutor(),
    );

    const result = await service.executeAction('action-approve-oracle', 'executor-req-3');

    expect(result.status).toBe('approved');
    expect(result.txHash).toBe('0xabc123');
  });

  test('marks failed actions and appends a failure audit log when execution fails', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-fail',
        category: 'treasury_sweep',
        contractMethod: 'claimTreasury',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceExecutorService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      createReader(),
      createInMemoryGovernanceExecutionLock(),
      createExecutor({
        execute: jest.fn().mockRejectedValue(new Error('rpc unavailable')),
      }),
    );

    const result = await service.executeAction('action-fail', 'executor-req-4');

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('EXECUTION_FAILED');
    expect(result.errorMessage).toContain('rpc unavailable');
    expect(auditLogStore.entries).toHaveLength(2);
    expect(auditLogStore.entries[1].eventType).toBe('governance.action.execution.failed');
  });

  test('does not re-execute actions that are no longer queued', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-done',
        status: 'executed',
        txHash: '0xalready',
        blockNumber: 21,
        executedAt: '2026-03-07T10:30:00.000Z',
      }),
    ]);
    const executor = createExecutor();
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceExecutorService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      createReader(),
      createInMemoryGovernanceExecutionLock(),
      executor,
    );

    const result = await service.executeAction('action-done', 'executor-req-5');

    expect(result.status).toBe('executed');
    expect(result.txHash).toBe('0xalready');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  test('surfaces reconciliation-required errors when persisting a successful execution fails', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-persist-fail',
        category: 'pause',
        contractMethod: 'pause',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const executor = createExecutor({
      execute: jest.fn().mockResolvedValue({
        txHash: '0xpersist123',
        blockNumber: 144,
      }),
    });
    const service = new GovernanceExecutorService(
      store,
      {
        saveActionWithAudit: jest.fn().mockRejectedValue(new Error('audit storage unavailable')),
      },
      auditLogStore,
      createReader(),
      createInMemoryGovernanceExecutionLock(),
      executor,
    );

    await expect(service.executeAction('action-persist-fail', 'executor-req-6'))
      .rejects
      .toMatchObject({
        code: 'INTERNAL_ERROR',
        details: expect.objectContaining({
          actionId: 'action-persist-fail',
          txHash: '0xpersist123',
          blockNumber: 144,
        }),
      });

    const unchanged = await store.get('action-persist-fail');
    expect(unchanged?.status).toBe('requested');
    expect(auditLogStore.entries).toHaveLength(1);
    expect(auditLogStore.entries[0].eventType).toBe('governance.action.execution.started');
  });

  test('persists tx outcome when post-execution status reads fail', async () => {
    const store = createInMemoryGovernanceActionStore([
      buildAction({
        actionId: 'action-approve-oracle-fallback',
        proposalId: 7,
        category: 'oracle_update',
        contractMethod: 'approveOracleUpdate',
      }),
    ]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new GovernanceExecutorService(
      store,
      createPassthroughGovernanceWriteStore(store, auditLogStore),
      auditLogStore,
      createReader({
        getGovernanceStatus: jest.fn().mockRejectedValue(new Error('rpc timeout during post-read')),
      }),
      createInMemoryGovernanceExecutionLock(),
      createExecutor({
        execute: jest.fn().mockResolvedValue({
          txHash: '0xpostread123',
          blockNumber: 201,
          proposalId: 7,
        }),
      }),
    );

    const result = await service.executeAction('action-approve-oracle-fallback', 'executor-req-7');

    expect(result.status).toBe('pending_approvals');
    expect(result.txHash).toBe('0xpostread123');
    expect(result.blockNumber).toBe(201);
    expect(result.errorCode).toBe('STATUS_RECONCILIATION_REQUIRED');
    expect(result.errorMessage).toContain('rpc timeout during post-read');

    const persisted = await store.get('action-approve-oracle-fallback');
    expect(persisted?.status).toBe('pending_approvals');
    expect(persisted?.txHash).toBe('0xpostread123');
    expect(persisted?.errorCode).toBe('STATUS_RECONCILIATION_REQUIRED');

    expect(auditLogStore.entries).toHaveLength(2);
    expect(auditLogStore.entries[1].eventType).toBe('governance.action.execution.succeeded');
    expect(auditLogStore.entries[1].metadata).toMatchObject({
      actionId: 'action-approve-oracle-fallback',
      txHash: '0xpostread123',
      errorCode: 'STATUS_RECONCILIATION_REQUIRED',
    });
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { getAddress } from 'ethers';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type { AuthSession } from '../src/core/authSessionClient';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { GatewayErrorHandlerWorkflow } from '../src/core/errorHandlerWorkflow';
import { createInMemoryFailedOperationStore } from '../src/core/failedOperationStore';
import {
  createInMemoryGovernanceActionStore,
  GovernanceActionStore,
} from '../src/core/governanceStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import {
  GovernanceMutationService,
  type GovernanceObservedTransaction,
  type GovernanceTransactionVerifier,
} from '../src/core/governanceMutationService';
import {
  GovernanceMutationPreflightReader,
  GovernanceProposalState,
  GovernanceStatusSnapshot,
  UnpauseProposalState,
} from '../src/core/governanceStatusService';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createGovernanceMutationRouter } from '../src/routes/governanceMutations';
import { createTradeRouter } from '../src/routes/trades';
import type { DashboardTradeRecord, TradeReadReader } from '../src/core/tradeReadService';

const baseConfig: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: [],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: true,
  writeAllowlist: ['uid-admin'],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: false,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const tradeFixture: DashboardTradeRecord = {
  id: 'TRD-LOCAL-9001',
  buyer: 'buyer@demo',
  supplier: 'supplier@demo',
  amount: 125000,
  currency: 'USDC',
  status: 'stage_1',
  txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  createdAt: '2026-03-07T09:00:00.000Z',
  updatedAt: '2026-03-07T10:00:00.000Z',
  ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  platformFee: 1250,
  logisticsAmount: 3000,
  complianceStatus: 'pass',
  settlement: {
    handoffId: 'sth-1',
    platformId: 'agroasys-platform',
    platformHandoffId: 'handoff-1',
    phase: 'stage_1',
    settlementChannel: 'cotsel_escrow',
    displayCurrency: 'USD',
    displayAmount: 125000,
    executionStatus: 'submitted',
    reconciliationStatus: 'pending',
    callbackStatus: 'pending',
    providerStatus: 'dispatch_received',
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    externalReference: 'EXT-1',
    latestEventType: 'submitted',
    latestEventDetail: 'Dispatch accepted by settlement engine.',
    latestEventAt: '2026-03-07T09:15:00.000Z',
    callbackDeliveredAt: null,
    createdAt: '2026-03-07T09:00:00.000Z',
    updatedAt: '2026-03-07T09:15:00.000Z',
  },
  timeline: [
    {
      stage: 'Lock',
      timestamp: '2026-03-07T09:00:00.000Z',
      actor: 'Buyer',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detail: 'Escrow locked for 125,000 USDC.',
    },
  ],
};

function buildStatusSnapshot(
  overrides: Partial<GovernanceStatusSnapshot> = {},
): GovernanceStatusSnapshot {
  return {
    paused: false,
    claimsPaused: false,
    oracleActive: true,
    oracleAddress: '0x0000000000000000000000000000000000000011',
    treasuryAddress: '0x0000000000000000000000000000000000000022',
    treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
    governanceApprovalsRequired: 2,
    governanceTimelockSeconds: 86400,
    requiredAdminCount: 2,
    hasActiveUnpauseProposal: false,
    activeUnpauseApprovals: 0,
    activeOracleProposalIds: [],
    activeTreasuryPayoutReceiverProposalIds: [],
    ...overrides,
  };
}

function buildProposalState(
  overrides: Partial<GovernanceProposalState> = {},
): GovernanceProposalState {
  return {
    proposalId: 7,
    approvalCount: 1,
    executed: false,
    cancelled: false,
    expired: false,
    etaSeconds: Math.floor(Date.now() / 1000) - 5,
    targetAddress: '0x0000000000000000000000000000000000000044',
    ...overrides,
  };
}

function buildUnpauseProposal(overrides: Partial<UnpauseProposalState> = {}): UnpauseProposalState {
  return {
    hasActiveProposal: true,
    approvalCount: 1,
    executed: false,
    ...overrides,
  };
}

function buildAuditBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    audit: {
      reason: 'Enterprise control action required for controlled governance execution.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-123' }],
      ticketRef: 'AGRO-123',
    },
  };
}

interface StartServerOptions {
  sessionRole?: 'admin' | 'buyer' | null;
  enableMutations?: boolean;
  writeAllowlist?: string[];
  sessionFixtures?: Record<string, AuthSession | null>;
  configureReader?: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => void;
  failQueueAction?: boolean;
  transactionVerifier?: GovernanceTransactionVerifier;
}

async function startServer(options: StartServerOptions = {}) {
  const config: GatewayConfig = {
    ...baseConfig,
    enableMutations: options.enableMutations ?? baseConfig.enableMutations,
    writeAllowlist: options.writeAllowlist ?? baseConfig.writeAllowlist,
  };

  const governanceReader: jest.Mocked<GovernanceMutationPreflightReader> = {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot()),
    getUnpauseProposalState: jest.fn().mockResolvedValue(buildUnpauseProposal()),
    getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState()),
    getTreasuryPayoutReceiverProposalState: jest.fn().mockResolvedValue(buildProposalState()),
    getTreasuryClaimableBalance: jest.fn().mockResolvedValue(10n),
    hasApprovedUnpause: jest.fn().mockResolvedValue(false),
    hasApprovedOracleProposal: jest.fn().mockResolvedValue(false),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn().mockResolvedValue(false),
  };
  options.configureReader?.(governanceReader);

  const defaultSessionFixtures: Record<string, AuthSession> = {
    'sess-admin': {
      accountId: 'acct-admin',
      userId: 'uid-admin',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      role: 'admin',
      email: 'admin@agroasys.io',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    'sess-admin-2': {
      accountId: 'acct-admin-2',
      userId: 'uid-admin-2',
      walletAddress: '0x00000000000000000000000000000000000000ac',
      role: 'admin',
      email: 'admin2@agroasys.io',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    'sess-buyer': {
      accountId: 'acct-buyer',
      userId: 'uid-buyer',
      walletAddress: '0x00000000000000000000000000000000000000bb',
      role: 'buyer',
      email: 'buyer@agroasys.io',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };

  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async (token: string) => {
      if (options.sessionRole === null) {
        return null;
      }

      if (options.sessionRole) {
        const fixture =
          options.sessionRole === 'admin'
            ? defaultSessionFixtures['sess-admin']
            : defaultSessionFixtures['sess-buyer'];
        return { ...fixture, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };
      }

      const fixture = options.sessionFixtures?.[token] ?? defaultSessionFixtures[token];
      if (!fixture) {
        return null;
      }

      return {
        ...fixture,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const auditLogStore = createInMemoryAuditLogStore();
  const failedOperationStore = createInMemoryFailedOperationStore();
  const governanceActionStore = createInMemoryGovernanceActionStore();
  const idempotencyStore = createInMemoryIdempotencyStore();
  const mutationService = new GovernanceMutationService(
    config,
    governanceActionStore,
    createPassthroughGovernanceWriteStore(governanceActionStore, auditLogStore),
    options.transactionVerifier,
  );
  const failedOperationWorkflow = new GatewayErrorHandlerWorkflow(
    failedOperationStore,
    auditLogStore,
  );

  if (options.failQueueAction) {
    jest
      .spyOn(mutationService, 'queueAction')
      .mockRejectedValue(new Error('governance queue unavailable'));
  }

  const router = Router();
  router.use(
    createGovernanceMutationRouter({
      authSessionClient,
      config,
      governanceReader,
      mutationService,
      idempotencyStore,
      failedOperationWorkflow,
    }),
  );

  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
    governanceReader,
    governanceActionStore,
    auditLogStore,
    failedOperationStore,
  };
}

async function readStoredAction(store: GovernanceActionStore, actionId: string) {
  const action = await store.get(actionId);
  if (!action) {
    throw new Error(`Expected stored governance action ${actionId}`);
  }

  return action;
}

function buildTradeReadService(): TradeReadReader {
  return {
    checkReadiness: jest.fn(),
    listTrades: jest.fn().mockResolvedValue([tradeFixture]),
    getTrade: jest
      .fn()
      .mockImplementation(async (tradeId: string) =>
        tradeId === tradeFixture.id ? tradeFixture : null,
      ),
  };
}

describe('gateway governance mutation routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateAccepted = createSchemaValidator(
    spec,
    '#/components/schemas/GovernanceActionAcceptedResponse',
  );
  const validatePrepared = createSchemaValidator(
    spec,
    '#/components/schemas/GovernanceActionPreparedResponse',
  );
  const validateConfirmed = createSchemaValidator(
    spec,
    '#/components/schemas/GovernanceBroadcastConfirmedResponse',
  );
  const validateError = createSchemaValidator(spec, '#/components/schemas/ErrorResponse');

  test('OpenAPI spec exposes all governance mutation endpoints', () => {
    const mutationPaths = [
      '/governance/pause',
      '/governance/unpause/proposal',
      '/governance/unpause/proposal/approve',
      '/governance/unpause/proposal/cancel',
      '/governance/claims/pause',
      '/governance/claims/unpause',
      '/governance/treasury/sweep',
      '/governance/treasury/payout-receiver/proposals',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/approve',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/execute',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/cancel-expired',
      '/governance/oracle/disable-emergency',
      '/governance/oracle/proposals',
      '/governance/oracle/proposals/{proposalId}/approve',
      '/governance/oracle/proposals/{proposalId}/execute',
      '/governance/oracle/proposals/{proposalId}/cancel-expired',
      '/governance/pause/prepare',
      '/governance/unpause/proposal/prepare',
      '/governance/unpause/proposal/approve/prepare',
      '/governance/unpause/proposal/cancel/prepare',
      '/governance/claims/pause/prepare',
      '/governance/claims/unpause/prepare',
      '/governance/treasury/sweep/prepare',
      '/governance/treasury/payout-receiver/proposals/prepare',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/approve/prepare',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/execute/prepare',
      '/governance/treasury/payout-receiver/proposals/{proposalId}/cancel-expired/prepare',
      '/governance/oracle/disable-emergency/prepare',
      '/governance/oracle/proposals/prepare',
      '/governance/oracle/proposals/{proposalId}/approve/prepare',
      '/governance/oracle/proposals/{proposalId}/execute/prepare',
      '/governance/oracle/proposals/{proposalId}/cancel-expired/prepare',
      '/governance/actions/{actionId}/confirm',
    ];

    mutationPaths.forEach((routePath) => {
      expect(hasOperation(spec, 'post', routePath)).toBe(true);
    });
  });

  test('POST /governance/pause/prepare returns the canonical signing payload and persists it', async () => {
    const { server, baseUrl, governanceActionStore } = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const response = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validatePrepared(payload)).toBe(true);
      expect(payload.data.status).toBe('prepared');
      expect(payload.data.signing).toMatchObject({
        chainId: 31337,
        contractAddress: baseConfig.escrowAddress,
        contractMethod: 'pause',
        args: [],
        signerWallet: getAddress('0x00000000000000000000000000000000000000aa'),
      });
      expect(payload.data.signing.txRequest).toMatchObject({
        chainId: 31337,
        to: baseConfig.escrowAddress,
        value: '0',
      });
      expect(payload.data.signing.txRequest.data).toMatch(/^0x[0-9a-f]+$/);
      expect(payload.data.signing.preparedPayloadHash).toMatch(/^[a-f0-9]{64}$/);

      const storedAction = await readStoredAction(governanceActionStore, payload.data.actionId);
      expect(storedAction.flowType).toBe('direct_sign');
      expect(storedAction.status).toBe('prepared');
      expect(storedAction.signing).toEqual(payload.data.signing);
      expect(storedAction.verificationState).toBe('not_started');
      expect(storedAction.monitoringState).toBe('not_started');
      expect(storedAction.actorId).toBe('account:acct-admin');
    } finally {
      server.close();
    }
  });

  test('direct-sign prepare routes require a wallet-bound session', async () => {
    const { server, baseUrl } = await startServer({
      sessionFixtures: {
        'sess-admin-no-wallet': {
          userId: 'uid-admin',
          walletAddress: '',
          role: 'admin',
          email: 'admin@agroasys.io',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const response = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin-no-wallet',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare-no-wallet',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(validateError(payload)).toBe(true);
      expect(payload.error.code).toBe('WALLET_SIGNER_REQUIRED');
    } finally {
      server.close();
    }
  });

  test('prepare routes reuse the same open direct-sign action for the same governance intent', async () => {
    const { server, baseUrl, governanceActionStore } = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const body = JSON.stringify(buildAuditBody());

      const firstResponse = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare-1',
        },
        body,
      });
      const firstPayload = await firstResponse.json();

      const secondResponse = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare-2',
        },
        body,
      });
      const secondPayload = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(firstPayload.data.actionId).toBe(secondPayload.data.actionId);
      expect(firstPayload.data.intentKey).toBe(secondPayload.data.intentKey);

      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  test('confirm rejects a broadcast transaction that does not match the prepared payload', async () => {
    const mismatchedTxHash = `0x${'1'.repeat(64)}`;
    const verifier: GovernanceTransactionVerifier = {
      getTransaction: jest.fn(async () => ({
        chainId: 31337,
        to: baseConfig.escrowAddress,
        from: '0x00000000000000000000000000000000000000aa',
        data: '0xdeadbeef',
        blockNumber: 42,
      })),
      getTransactionReceipt: jest.fn(async () => null),
      getBlockNumber: jest.fn(async () => null),
    };

    const { server, baseUrl } = await startServer({
      transactionVerifier: verifier,
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const prepareResponse = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare-mismatch',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const prepared = await prepareResponse.json();

      const confirmResponse = await fetch(
        `${baseUrl}/governance/actions/${encodeURIComponent(prepared.data.actionId)}/confirm`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            txHash: mismatchedTxHash,
            signerWallet: '0x00000000000000000000000000000000000000aa',
          }),
        },
      );
      const confirmPayload = await confirmResponse.json();

      expect(confirmResponse.status).toBe(409);
      expect(validateError(confirmPayload)).toBe(true);
      expect(confirmPayload.error.message).toContain('calldata');
    } finally {
      server.close();
    }
  });

  test('confirm stores pending verification when the tx is not yet observable on-chain', async () => {
    const pendingTxHash = `0x${'2'.repeat(64)}`;
    const verifier: GovernanceTransactionVerifier = {
      getTransaction: jest.fn(async () => null),
      getTransactionReceipt: jest.fn(async () => null),
      getBlockNumber: jest.fn(async () => null),
    };

    const { server, baseUrl, governanceActionStore } = await startServer({
      transactionVerifier: verifier,
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const prepareResponse = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare-pending',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const prepared = await prepareResponse.json();

      const confirmResponse = await fetch(
        `${baseUrl}/governance/actions/${encodeURIComponent(prepared.data.actionId)}/confirm`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            txHash: pendingTxHash,
            signerWallet: '0x00000000000000000000000000000000000000aa',
          }),
        },
      );
      const confirmPayload = await confirmResponse.json();

      expect(confirmResponse.status).toBe(200);
      expect(validateConfirmed(confirmPayload)).toBe(true);
      expect(confirmPayload.data.status).toBe('broadcast_pending_verification');
      expect(confirmPayload.data.verificationState).toBe('pending');
      expect(confirmPayload.data.monitoringState).toBe('pending_verification');
      expect(confirmPayload.data.signerWallet).toBeNull();

      const storedAction = await readStoredAction(governanceActionStore, prepared.data.actionId);
      expect(storedAction.status).toBe('broadcast_pending_verification');
      expect(storedAction.txHash).toBe(pendingTxHash);
      expect(storedAction.verificationState).toBe('pending');
      expect(storedAction.monitoringState).toBe('pending_verification');
      expect(storedAction.finalSignerWallet).toBeNull();
      expect(storedAction.audit.finalSignerWallet).toBeUndefined();
    } finally {
      server.close();
    }
  });

  test('confirm verifies the tx against the prepared action and records the final signer', async () => {
    const verifiedTxHash = `0x${'3'.repeat(64)}`;
    let preparedTxRequest: GovernanceObservedTransaction | null = null;
    const verifier: GovernanceTransactionVerifier = {
      getTransaction: jest.fn(async () => preparedTxRequest),
      getTransactionReceipt: jest.fn(async () => null),
      getBlockNumber: jest.fn(async () => null),
    };

    const { server, baseUrl, governanceActionStore } = await startServer({
      transactionVerifier: verifier,
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const prepareResponse = await fetch(`${baseUrl}/governance/pause/prepare`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-prepare-verified',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const prepared = await prepareResponse.json();

      preparedTxRequest = {
        chainId: prepared.data.signing.chainId,
        to: prepared.data.signing.contractAddress,
        from: prepared.data.signing.signerWallet,
        data: prepared.data.signing.txRequest.data,
        blockNumber: 88,
      };

      const confirmResponse = await fetch(
        `${baseUrl}/governance/actions/${encodeURIComponent(prepared.data.actionId)}/confirm`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            txHash: verifiedTxHash,
            signerWallet: prepared.data.signing.signerWallet,
          }),
        },
      );
      const confirmPayload = await confirmResponse.json();

      expect(confirmResponse.status).toBe(200);
      expect(validateConfirmed(confirmPayload)).toBe(true);
      expect(confirmPayload.data.status).toBe('broadcast');
      expect(confirmPayload.data.verificationState).toBe('verified');
      expect(confirmPayload.data.monitoringState).toBe('pending_confirmation');
      expect(confirmPayload.data.signerWallet).toBe(prepared.data.signing.signerWallet);
      expect(confirmPayload.data.blockNumber).toBe(88);

      const storedAction = await readStoredAction(governanceActionStore, prepared.data.actionId);
      expect(storedAction.status).toBe('broadcast');
      expect(storedAction.finalSignerWallet).toBe(prepared.data.signing.signerWallet);
      expect(storedAction.audit.finalSignerWallet).toBe(prepared.data.signing.signerWallet);
      expect(storedAction.audit.finalSignerVerifiedAt).toBeTruthy();
      expect(storedAction.monitoringState).toBe('pending_confirmation');
    } finally {
      server.close();
    }
  });

  test('infrastructure failures dead-letter governance queue mutations and preserve logical idempotency', async () => {
    const { server, baseUrl, failedOperationStore } = await startServer({
      failQueueAction: true,
    });

    try {
      const firstResponse = await fetch(`${baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-governance-dead-letter',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const firstPayload = await firstResponse.json();
      expect(firstResponse.status).toBe(503);
      expect(validateError(firstPayload)).toBe(true);
      expect(firstPayload.error.details.failedOperationId).toBeTruthy();

      const secondResponse = await fetch(`${baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-governance-dead-letter',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      expect(secondResponse.status).toBe(503);

      const failedOperations = await failedOperationStore.list();
      expect(failedOperations).toHaveLength(1);
      expect(failedOperations[0]).toMatchObject({
        operationType: 'governance.queue_action',
        failureState: 'open',
        replayEligible: true,
        retryCount: 2,
        idempotencyKey: 'idem-governance-dead-letter',
      });
    } finally {
      server.close();
    }
  });

  test('governance mutation middleware does not intercept trade reads when routers share the app boundary', async () => {
    const config: GatewayConfig = {
      ...baseConfig,
      enableMutations: true,
      writeAllowlist: ['uid-admin'],
    };

    const governanceReader: jest.Mocked<GovernanceMutationPreflightReader> = {
      checkReadiness: jest.fn(),
      getGovernanceStatus: jest.fn().mockResolvedValue(buildStatusSnapshot()),
      getUnpauseProposalState: jest.fn().mockResolvedValue(buildUnpauseProposal()),
      getOracleProposalState: jest.fn().mockResolvedValue(buildProposalState()),
      getTreasuryPayoutReceiverProposalState: jest.fn().mockResolvedValue(buildProposalState()),
      getTreasuryClaimableBalance: jest.fn().mockResolvedValue(10n),
      hasApprovedUnpause: jest.fn().mockResolvedValue(false),
      hasApprovedOracleProposal: jest.fn().mockResolvedValue(false),
      hasApprovedTreasuryPayoutReceiverProposal: jest.fn().mockResolvedValue(false),
    };

    const authSessionClient: AuthSessionClient = {
      resolveSession: jest.fn().mockResolvedValue({
        userId: 'uid-admin',
        walletAddress: '0x00000000000000000000000000000000000000aa',
        role: 'admin',
        email: 'admin@agroasys.io',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      checkReadiness: jest.fn(),
    };

    const governanceActionStore = createInMemoryGovernanceActionStore();
    const auditLogStore = createInMemoryAuditLogStore();
    const router = Router();
    router.use(
      createGovernanceMutationRouter({
        authSessionClient,
        config,
        governanceReader,
        mutationService: new GovernanceMutationService(
          config,
          governanceActionStore,
          createPassthroughGovernanceWriteStore(governanceActionStore, auditLogStore),
        ),
        idempotencyStore: createInMemoryIdempotencyStore(),
        failedOperationWorkflow: new GatewayErrorHandlerWorkflow(
          createInMemoryFailedOperationStore(),
          auditLogStore,
        ),
      }),
    );
    router.use(
      createTradeRouter({
        authSessionClient,
        config,
        tradeReadService: buildTradeReadService(),
      }),
    );

    const app = createApp(config, {
      version: '0.1.0',
      commitSha: config.commitSha,
      buildTime: config.buildTime,
      readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
      extraRouter: router,
    });

    const server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve server address');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1/trades?limit=1&offset=0`,
        {
          headers: { Authorization: 'Bearer sess-admin', 'x-request-id': 'req-trades' },
        },
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data[0].id).toBe(tradeFixture.id);
    } finally {
      server.close();
    }
  });

  test.each([
    {
      name: 'pause protocol',
      path: '/governance/pause',
      body: buildAuditBody(),
      expectedCategory: 'pause',
      expectedMethod: 'pause',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    },
    {
      name: 'propose unpause',
      path: '/governance/unpause/proposal',
      body: buildAuditBody(),
      expectedCategory: 'unpause',
      expectedMethod: 'proposeUnpause',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(
          buildStatusSnapshot({ paused: true, oracleActive: true }),
        );
      },
    },
    {
      name: 'approve unpause',
      path: '/governance/unpause/proposal/approve',
      body: buildAuditBody(),
      expectedCategory: 'unpause',
      expectedMethod: 'approveUnpause',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getUnpauseProposalState.mockResolvedValue(
          buildUnpauseProposal({ hasActiveProposal: true, approvalCount: 1 }),
        );
        reader.hasApprovedUnpause.mockResolvedValue(false);
      },
    },
    {
      name: 'cancel unpause',
      path: '/governance/unpause/proposal/cancel',
      body: buildAuditBody(),
      expectedCategory: 'unpause',
      expectedMethod: 'cancelUnpauseProposal',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getUnpauseProposalState.mockResolvedValue(
          buildUnpauseProposal({ hasActiveProposal: true }),
        );
      },
    },
    {
      name: 'pause claims',
      path: '/governance/claims/pause',
      body: buildAuditBody(),
      expectedCategory: 'claims_pause',
      expectedMethod: 'pauseClaims',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ claimsPaused: false }));
      },
    },
    {
      name: 'unpause claims',
      path: '/governance/claims/unpause',
      body: buildAuditBody(),
      expectedCategory: 'claims_unpause',
      expectedMethod: 'unpauseClaims',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ claimsPaused: true }));
      },
    },
    {
      name: 'queue treasury sweep',
      path: '/governance/treasury/sweep',
      body: buildAuditBody(),
      expectedCategory: 'treasury_sweep',
      expectedMethod: 'claimTreasury',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ claimsPaused: false }));
        reader.getTreasuryClaimableBalance.mockResolvedValue(25n);
      },
    },
    {
      name: 'propose treasury payout receiver update',
      path: '/governance/treasury/payout-receiver/proposals',
      body: buildAuditBody({ newPayoutReceiver: '0x0000000000000000000000000000000000000099' }),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'proposeTreasuryPayoutAddressUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(
          buildStatusSnapshot({
            treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
          }),
        );
      },
    },
    {
      name: 'approve treasury payout receiver proposal',
      path: '/governance/treasury/payout-receiver/proposals/7/approve',
      body: buildAuditBody(),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'approveTreasuryPayoutAddressUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getTreasuryPayoutReceiverProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            approvalCount: 1,
            expired: false,
            cancelled: false,
            executed: false,
          }),
        );
        reader.hasApprovedTreasuryPayoutReceiverProposal.mockResolvedValue(false);
      },
    },
    {
      name: 'execute treasury payout receiver proposal',
      path: '/governance/treasury/payout-receiver/proposals/7/execute',
      body: buildAuditBody(),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'executeTreasuryPayoutAddressUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(
          buildStatusSnapshot({ governanceApprovalsRequired: 2 }),
        );
        reader.getTreasuryPayoutReceiverProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            approvalCount: 2,
            etaSeconds: Math.floor(Date.now() / 1000) - 5,
          }),
        );
      },
    },
    {
      name: 'cancel expired treasury payout receiver proposal',
      path: '/governance/treasury/payout-receiver/proposals/7/cancel-expired',
      body: buildAuditBody(),
      expectedCategory: 'treasury_payout_receiver_update',
      expectedMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getTreasuryPayoutReceiverProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            expired: true,
          }),
        );
      },
    },
    {
      name: 'disable oracle emergency',
      path: '/governance/oracle/disable-emergency',
      body: buildAuditBody(),
      expectedCategory: 'oracle_disable_emergency',
      expectedMethod: 'disableOracleEmergency',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ oracleActive: true }));
      },
    },
    {
      name: 'propose oracle update',
      path: '/governance/oracle/proposals',
      body: buildAuditBody({ newOracleAddress: '0x00000000000000000000000000000000000000f1' }),
      expectedCategory: 'oracle_update',
      expectedMethod: 'proposeOracleUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(
          buildStatusSnapshot({
            oracleAddress: '0x0000000000000000000000000000000000000011',
          }),
        );
      },
    },
    {
      name: 'approve oracle proposal',
      path: '/governance/oracle/proposals/7/approve',
      body: buildAuditBody(),
      expectedCategory: 'oracle_update',
      expectedMethod: 'approveOracleUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getOracleProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            approvalCount: 1,
            expired: false,
            cancelled: false,
            executed: false,
          }),
        );
        reader.hasApprovedOracleProposal.mockResolvedValue(false);
      },
    },
    {
      name: 'execute oracle proposal',
      path: '/governance/oracle/proposals/7/execute',
      body: buildAuditBody(),
      expectedCategory: 'oracle_update',
      expectedMethod: 'executeOracleUpdate',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getGovernanceStatus.mockResolvedValue(
          buildStatusSnapshot({ governanceApprovalsRequired: 2 }),
        );
        reader.getOracleProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            approvalCount: 2,
            etaSeconds: Math.floor(Date.now() / 1000) - 5,
          }),
        );
      },
    },
    {
      name: 'cancel expired oracle proposal',
      path: '/governance/oracle/proposals/7/cancel-expired',
      body: buildAuditBody(),
      expectedCategory: 'oracle_update',
      expectedMethod: 'cancelExpiredOracleUpdateProposal',
      configureReader: (reader: jest.Mocked<GovernanceMutationPreflightReader>) => {
        reader.getOracleProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            expired: true,
          }),
        );
      },
    },
  ])(
    'POST $path accepts and persists $name',
    async ({ path, body, expectedCategory, expectedMethod, configureReader }) => {
      const { server, baseUrl, governanceActionStore, auditLogStore } = await startServer({
        configureReader,
      });

      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'content-type': 'application/json',
            'Idempotency-Key': `idem-${expectedMethod}`,
            'x-request-id': `req-${expectedMethod}`,
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json();

        expect(response.status).toBe(202);
        expect(response.headers.get('x-request-id')).toBe(`req-${expectedMethod}`);
        expect(validateAccepted(payload)).toBe(true);
        expect(payload.data.category).toBe(expectedCategory);
        expect(payload.data.status).toBe('requested');
        expect(typeof payload.data.intentKey).toBe('string');
        expect(payload.data.expiresAt).toMatch(/Z$/);

        const storedAction = await readStoredAction(governanceActionStore, payload.data.actionId);
        expect(storedAction.category).toBe(expectedCategory);
        expect(storedAction.contractMethod).toBe(expectedMethod);
        expect(storedAction.intentKey).toBe(payload.data.intentKey);
        expect(storedAction.idempotencyKey).toBe(`idem-${expectedMethod}`);
        expect(storedAction.actorId).toBe('account:acct-admin');
        expect(storedAction.endpoint).toBe(`/api/dashboard-gateway/v1${path}`);
        expect(storedAction.intentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(storedAction.expiresAt).toBe(payload.data.expiresAt);
        expect(storedAction.requestId).toBe(`req-${expectedMethod}`);
        expect(storedAction.audit.actorSessionId).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(storedAction.audit.actorSessionId).not.toBe('sess-admin');
        expect(auditLogStore.entries[0]).toMatchObject({
          actionId: payload.data.actionId,
          idempotencyKey: `idem-${expectedMethod}`,
          actorId: 'account:acct-admin',
        });
      } finally {
        server.close();
      }
    },
  );

  test('mutation routes replay accepted responses for duplicate idempotency keys', async () => {
    const { server, baseUrl, governanceActionStore, auditLogStore } = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const headers = {
        Authorization: 'Bearer sess-admin',
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-pause',
      };
      const body = JSON.stringify(buildAuditBody());

      const first = await fetch(`${baseUrl}/governance/pause`, { method: 'POST', headers, body });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/governance/pause`, { method: 'POST', headers, body });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers.get('x-idempotent-replay')).toBe('true');
      expect(firstPayload).toEqual(secondPayload);

      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(1);
      expect(auditLogStore.entries).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  test('mutation routes scope idempotency by actor and reject client-supplied action ids', async () => {
    const { server, baseUrl, governanceActionStore } = await startServer({
      writeAllowlist: ['uid-admin', 'uid-admin-2'],
      configureReader(reader) {
        reader.getOracleProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            approvalCount: 1,
            expired: false,
            cancelled: false,
            executed: false,
          }),
        );
        reader.hasApprovedOracleProposal.mockResolvedValue(false);
      },
    });

    try {
      const body = JSON.stringify(buildAuditBody());

      const first = await fetch(`${baseUrl}/governance/oracle/proposals/7/approve`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-shared-approval',
        },
        body,
      });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/governance/oracle/proposals/7/approve`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin-2',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-shared-approval',
        },
        body,
      });
      const secondPayload = await second.json();

      const invalid = await fetch(`${baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-invalid-action-id',
        },
        body: JSON.stringify(buildAuditBody({ actionId: 'client-controlled-action' })),
      });
      const invalidPayload = await invalid.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(firstPayload.data.actionId).not.toBe(secondPayload.data.actionId);
      expect(invalid.status).toBe(400);
      expect(validateError(invalidPayload)).toBe(true);
      expect(invalidPayload.error.message).toContain('actionId is server-generated');

      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  test('semantic dedupe returns the same queued action for duplicate intent with different idempotency keys', async () => {
    const { server, baseUrl, governanceActionStore, auditLogStore } = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });

    try {
      const body = JSON.stringify(buildAuditBody());

      const first = await fetch(`${baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-1',
          'x-request-id': 'req-pause-1',
        },
        body,
      });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-pause-2',
          'x-request-id': 'req-pause-2',
        },
        body,
      });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(firstPayload.data.actionId).toBe(secondPayload.data.actionId);
      expect(firstPayload.data.intentKey).toBe(secondPayload.data.intentKey);
      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(1);
      expect(auditLogStore.entries.map((entry) => entry.eventType)).toEqual([
        'governance.action.queued',
        'governance.action.duplicate_reused',
      ]);
    } finally {
      server.close();
    }
  });

  test('approval actions keep separate queued intents for different admin wallets', async () => {
    const { server, baseUrl, governanceActionStore, auditLogStore } = await startServer({
      writeAllowlist: ['uid-admin', 'uid-admin-2'],
      configureReader(reader) {
        reader.getOracleProposalState.mockResolvedValue(
          buildProposalState({
            proposalId: 7,
            approvalCount: 1,
            expired: false,
            cancelled: false,
            executed: false,
          }),
        );
        reader.hasApprovedOracleProposal.mockResolvedValue(false);
      },
    });

    try {
      const body = JSON.stringify(buildAuditBody());

      const first = await fetch(`${baseUrl}/governance/oracle/proposals/7/approve`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-approve-oracle-1',
        },
        body,
      });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/governance/oracle/proposals/7/approve`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin-2',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-approve-oracle-2',
        },
        body,
      });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(firstPayload.data.actionId).not.toBe(secondPayload.data.actionId);
      expect(firstPayload.data.intentKey).not.toBe(secondPayload.data.intentKey);

      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(2);
      expect(stored.items.map((action) => action.audit.actorWallet)).toEqual(
        expect.arrayContaining([
          '0x00000000000000000000000000000000000000aa',
          '0x00000000000000000000000000000000000000ac',
        ]),
      );
      expect(auditLogStore.entries.map((entry) => entry.eventType)).toEqual([
        'governance.action.queued',
        'governance.action.queued',
      ]);
    } finally {
      server.close();
    }
  });

  test('different governance parameters produce different intent keys', async () => {
    const { server, baseUrl, governanceActionStore } = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(
          buildStatusSnapshot({
            oracleAddress: '0x0000000000000000000000000000000000000011',
          }),
        );
      },
    });

    try {
      const first = await fetch(`${baseUrl}/governance/oracle/proposals`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-oracle-1',
        },
        body: JSON.stringify(
          buildAuditBody({ newOracleAddress: '0x00000000000000000000000000000000000000f1' }),
        ),
      });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/governance/oracle/proposals`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-oracle-2',
        },
        body: JSON.stringify(
          buildAuditBody({ newOracleAddress: '0x00000000000000000000000000000000000000f2' }),
        ),
      });
      const secondPayload = await second.json();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(firstPayload.data.intentKey).not.toBe(secondPayload.data.intentKey);

      const stored = await governanceActionStore.list({ limit: 10 });
      expect(stored.items).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  test('mutation routes enforce authentication and write gating deterministically', async () => {
    const unauthenticated = await startServer({ sessionRole: null });
    const nonAdmin = await startServer({ sessionRole: 'buyer' });
    const disabled = await startServer({ enableMutations: false });
    const notAllowlisted = await startServer({ writeAllowlist: [] });

    try {
      const requestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-authz',
        },
        body: JSON.stringify(buildAuditBody()),
      };

      const unauthenticatedResponse = await fetch(
        `${unauthenticated.baseUrl}/governance/pause`,
        requestInit,
      );
      const unauthenticatedPayload = await unauthenticatedResponse.json();
      expect(unauthenticatedResponse.status).toBe(401);
      expect(validateError(unauthenticatedPayload)).toBe(true);
      expect(unauthenticatedPayload.error.code).toBe('AUTH_REQUIRED');

      const nonAdminResponse = await fetch(`${nonAdmin.baseUrl}/governance/pause`, {
        ...requestInit,
        headers: {
          ...requestInit.headers,
          Authorization: 'Bearer sess-buyer',
        },
      });
      const nonAdminPayload = await nonAdminResponse.json();
      expect(nonAdminResponse.status).toBe(403);
      expect(nonAdminPayload.error.code).toBe('FORBIDDEN');
      const nonAdminActions = await nonAdmin.governanceActionStore.list({ limit: 10 });
      expect(nonAdminActions.items).toHaveLength(0);
      expect(nonAdmin.auditLogStore.entries).toHaveLength(0);

      const disabledResponse = await fetch(`${disabled.baseUrl}/governance/pause`, {
        ...requestInit,
        headers: {
          ...requestInit.headers,
          Authorization: 'Bearer sess-admin',
        },
      });
      const disabledPayload = await disabledResponse.json();
      expect(disabledResponse.status).toBe(403);
      expect(disabledPayload.error.code).toBe('FORBIDDEN');
      expect(disabledPayload.error.details.reason).toBe('disabled_or_not_allowlisted');
      const disabledActions = await disabled.governanceActionStore.list({ limit: 10 });
      expect(disabledActions.items).toHaveLength(0);
      expect(disabled.auditLogStore.entries).toHaveLength(0);

      const notAllowlistedResponse = await fetch(`${notAllowlisted.baseUrl}/governance/pause`, {
        ...requestInit,
        headers: {
          ...requestInit.headers,
          Authorization: 'Bearer sess-admin',
        },
      });
      const notAllowlistedPayload = await notAllowlistedResponse.json();
      expect(notAllowlistedResponse.status).toBe(403);
      expect(notAllowlistedPayload.error.code).toBe('FORBIDDEN');
      expect(notAllowlistedPayload.error.details.reason).toBe('disabled_or_not_allowlisted');
      const notAllowlistedActions = await notAllowlisted.governanceActionStore.list({ limit: 10 });
      expect(notAllowlistedActions.items).toHaveLength(0);
      expect(notAllowlisted.auditLogStore.entries).toHaveLength(0);
    } finally {
      unauthenticated.server.close();
      nonAdmin.server.close();
      disabled.server.close();
      notAllowlisted.server.close();
    }
  });

  test('mutation routes reject invalid payloads and state conflicts with schema-valid errors', async () => {
    const invalidServer = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: false }));
      },
    });
    const conflictServer = await startServer({
      configureReader(reader) {
        reader.getGovernanceStatus.mockResolvedValue(buildStatusSnapshot({ paused: true }));
        reader.getOracleProposalState.mockResolvedValue(null);
      },
    });

    try {
      const invalidResponse = await fetch(`${invalidServer.baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-invalid',
        },
        body: JSON.stringify({}),
      });
      const invalidPayload = await invalidResponse.json();
      expect(invalidResponse.status).toBe(400);
      expect(validateError(invalidPayload)).toBe(true);
      expect(invalidPayload.error.code).toBe('VALIDATION_ERROR');

      const conflictResponse = await fetch(`${conflictServer.baseUrl}/governance/pause`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'content-type': 'application/json',
          'Idempotency-Key': 'idem-conflict',
        },
        body: JSON.stringify(buildAuditBody()),
      });
      const conflictPayload = await conflictResponse.json();
      expect(conflictResponse.status).toBe(409);
      expect(validateError(conflictPayload)).toBe(true);
      expect(conflictPayload.error.code).toBe('CONFLICT');

      const missingResponse = await fetch(
        `${conflictServer.baseUrl}/governance/oracle/proposals/99/approve`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sess-admin',
            'content-type': 'application/json',
            'Idempotency-Key': 'idem-missing',
          },
          body: JSON.stringify(buildAuditBody()),
        },
      );
      const missingPayload = await missingResponse.json();
      expect(missingResponse.status).toBe(404);
      expect(validateError(missingPayload)).toBe(true);
      expect(missingPayload.error.code).toBe('NOT_FOUND');
    } finally {
      invalidServer.server.close();
      conflictServer.server.close();
    }
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cotsel#951: a trade-scoped unpause releases a contained trade, so the
 * gateway prepares its approval only when the trade's signed reconciliation
 * evidence verifies. Global and claims unpauses are unaffected.
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import { createGovernanceRouter } from '../src/routes/governance';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import type {
  GovernanceMutationPreflightReader,
  UnpauseProposalState,
} from '../src/core/governanceStatusService';
import { createInMemoryGovernanceActionStore } from '../src/core/governanceInMemoryStore';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';
import { GovernanceMutationService } from '../src/core/governanceMutationService';
import type { GovernanceTransactionVerifier } from '../src/core/governanceMutationTypes';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { createInMemoryGovernanceTransitionStore } from '../src/core/governanceTransitionStore';
import type { ContainmentEvidenceService } from '../src/core/containmentEvidence';
import { GatewayError } from '../src/errors';
import { freshStepUp } from './support/stepUp';

const config: GatewayConfig = {
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
  usdcAddress: '0x0000000000000000000000000000000000000888',
  operatorSignerEnvironment: 'staging',
  enableMutations: true,
  writeAllowlist: ['acct-admin'],
  governancePreparationTtlSeconds: 86400,
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
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

const SIGNER = '0x00000000000000000000000000000000000000aa';

async function startServer(
  proposal: UnpauseProposalState,
  containmentEvidence: ContainmentEvidenceService | undefined,
) {
  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockResolvedValue({
      userId: 'uid-admin',
      accountId: 'acct-admin',
      walletAddress: SIGNER,
      role: 'admin',
      capabilities: ['governance:write'],
      signerAuthorizations: [
        {
          bindingId: 'governance-signer',
          walletAddress: SIGNER,
          actionClass: 'governance',
          environment: 'staging',
          approvedAt: '2026-09-11T08:00:00.000Z',
          approvedBy: 'acct-approver',
          ticketRef: 'COTSEL-951',
          notes: null,
        },
      ],
      breakGlass: {
        active: false,
        role: null,
        expiresAt: null,
        grantedAt: null,
        grantedBy: null,
        reason: null,
        revokedAt: null,
        revokedBy: null,
        reviewedAt: null,
        reviewedBy: null,
        reviewStatus: 'none',
      },
      authentication: freshStepUp(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    }),
    checkReadiness: jest.fn(),
  };
  const governanceStatusService = {
    checkReadiness: jest.fn(),
    getGovernanceStatus: jest.fn(),
    getUnpauseProposalState: jest.fn().mockResolvedValue(proposal),
    getOracleProposalState: jest.fn(),
    getTreasuryPayoutReceiverProposalState: jest.fn(),
    getTreasuryClaimableBalance: jest.fn(),
    hasApprovedUnpause: jest.fn().mockResolvedValue(false),
    hasApprovedOracleProposal: jest.fn(),
    hasApprovedTreasuryPayoutReceiverProposal: jest.fn(),
  } as unknown as GovernanceMutationPreflightReader;
  const governanceActionStore = createInMemoryGovernanceActionStore();
  const auditStore = createInMemoryAuditLogStore();
  const verifier: GovernanceTransactionVerifier = {
    getTransactionCount: jest.fn(async () => 0),
    simulateTransaction: jest.fn(async () => ({
      chainId: 31337,
      blockNumber: 1,
      blockHash: `0x${'1'.repeat(64)}`,
      simulatedAt: new Date().toISOString(),
      providerIdentity: `sha256:${'a'.repeat(64)}`,
      result: 'success' as const,
      returnDataHash: 'b'.repeat(64),
      pointInTimeOnly: true as const,
    })),
    getTransaction: jest.fn(async () => null),
    getTransactionReceipt: jest.fn(async () => null),
    getBlockNumber: jest.fn(async () => null),
    observeTransactionFinality: jest.fn(async () => {
      throw new Error('not observed in this test');
    }),
  };
  const router = Router();
  router.use(
    createGovernanceRouter({
      authSessionClient,
      config,
      governanceStatusService,
      governanceActionStore,
      governanceMutationService: new GovernanceMutationService(
        config,
        governanceActionStore,
        createPassthroughGovernanceWriteStore(governanceActionStore, auditStore),
        createInMemoryGovernanceTransitionStore(governanceActionStore, auditStore),
        verifier,
      ),
      idempotencyStore: createInMemoryIdempotencyStore(),
      containmentEvidence,
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
  if (!address || typeof address === 'string') throw new Error('no server address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1` };
}

async function approve(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl}/governance/unpause/proposal/approve/prepare`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer sess-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      signerWallet: SIGNER,
      audit: {
        reason: 'Approve the governed unpause of a reconciled trade.',
        ticketRef: 'COTSEL-951',
        evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/COTSEL-951' }],
      },
    }),
  });
  return { status: response.status, body: await response.json() };
}

const TRADE_PROPOSAL: UnpauseProposalState = {
  hasActiveProposal: true,
  approvalCount: 0,
  executed: false,
  scope: 'TRADE',
  tradeId: '42',
};

function evidence(requireVerified: ContainmentEvidenceService['requireVerified']) {
  return {
    list: jest.fn(),
    get: jest.fn(),
    requireVerified: jest.fn(requireVerified),
    close: jest.fn(),
  } as unknown as ContainmentEvidenceService & { requireVerified: jest.Mock };
}

describe('trade-scoped unpause approval needs verified reconciliation evidence (Cotsel#951)', () => {
  it.each([
    ['tampered', 'reconciliation_evidence_invalid'],
    ['unsigned', 'reconciliation_evidence_unsigned'],
  ])('refuses when the evidence is %s, before anything is prepared', async (_label, reason) => {
    const service = evidence(async () => {
      throw new GatewayError(409, 'CONFLICT', 'evidence does not verify', {
        reason,
        tradeId: '42',
      });
    });
    const { server, baseUrl } = await startServer(TRADE_PROPOSAL, service);
    try {
      const result = await approve(baseUrl, `trade-unpause-${reason}`);
      expect(result.status).toBe(409);
      expect(result.body.error.details).toMatchObject({ reason, tradeId: '42' });
      expect(service.requireVerified).toHaveBeenCalledWith('42');
    } finally {
      server.close();
    }
  });

  it('fails closed when the gateway has no reconciliation evidence configured', async () => {
    const { server, baseUrl } = await startServer(TRADE_PROPOSAL, undefined);
    try {
      const result = await approve(baseUrl, 'trade-unpause-unconfigured');
      expect(result.status).toBe(503);
      expect(result.body.error.details).toMatchObject({
        reason: 'reconciliation_evidence_unconfigured',
      });
    } finally {
      server.close();
    }
  });

  it('prepares the approval when the evidence verifies', async () => {
    const service = evidence(async () => ({}) as never);
    const { server, baseUrl } = await startServer(TRADE_PROPOSAL, service);
    try {
      const result = await approve(baseUrl, 'trade-unpause-verified');
      expect(result.status).toBe(200);
      expect(service.requireVerified).toHaveBeenCalledWith('42');
    } finally {
      server.close();
    }
  });

  it('does not consult reconciliation for a global unpause', async () => {
    const service = evidence(async () => {
      throw new Error('must not be called');
    });
    const { server, baseUrl } = await startServer(
      { ...TRADE_PROPOSAL, scope: 'GLOBAL', tradeId: '0' },
      service,
    );
    try {
      const result = await approve(baseUrl, 'global-unpause');
      expect(result.status).toBe(200);
      expect(service.requireVerified).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cotsel#951: a trade-scoped unpause releases a contained trade, so the
 * gateway prepares its approval only when the trade's signed reconciliation
 * evidence verifies. Global and claims unpauses are unaffected.
 */
import type { Server } from 'http';
import { Router, type RequestHandler } from 'express';
import { createApp } from '../../src/app';
import type { GatewayConfig } from '../../src/config/env';
import { createGovernanceRouter } from '../../src/routes/governance';
import type { AuthSessionClient } from '../../src/core/authSessionClient';
import type {
  GovernanceMutationPreflightReader,
  UnpauseProposalState,
} from '../../src/core/governanceStatusService';
import { createInMemoryGovernanceActionStore } from '../../src/core/governanceInMemoryStore';
import { createInMemoryAuditLogStore } from '../../src/core/auditLogStore';
import { createPassthroughGovernanceWriteStore } from '../../src/core/governanceWriteStore';
import { GovernanceMutationService } from '../../src/core/governanceMutationService';
import type { GovernanceTransactionVerifier } from '../../src/core/governanceMutationTypes';
import { createInMemoryIdempotencyStore } from '../../src/core/idempotencyStore';
import { createInMemoryGovernanceTransitionStore } from '../../src/core/governanceTransitionStore';
import { type ContainmentEvidenceService } from '../../src/core/containmentEvidence';
import { freshStepUp } from './stepUp';

import type { Pool } from 'pg';
import { createPostgresGovernanceActionStore } from '../../src/core/governancePostgresStore';
import { createPostgresGovernanceWriteStore } from '../../src/core/governanceWriteStore';
import { createPostgresGovernanceTransitionStore } from '../../src/core/governancePostgresTransitionStore';
import { createPostgresAuditLogStore } from '../../src/core/auditLogStore';
import { createPostgresFreezeReviewStore } from '../../src/core/freezeReviewStore';

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
  chainId: 84532,
  escrowAddress: '0x1111111111111111111111111111111111111111',
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

export async function startGovernanceEvidenceServer(
  proposal: UnpauseProposalState,
  containmentEvidence: ContainmentEvidenceService | undefined,
  dbPool?: Pool,
  requestRateLimitMiddleware?: RequestHandler,
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
  const governanceActionStore = dbPool
    ? createPostgresGovernanceActionStore(dbPool)
    : createInMemoryGovernanceActionStore();
  const auditStore = dbPool ? createPostgresAuditLogStore(dbPool) : createInMemoryAuditLogStore();
  const verifier: GovernanceTransactionVerifier = {
    getTransactionCount: jest.fn(async () => 0),
    simulateTransaction: jest.fn(async () => ({
      chainId: 84532,
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
        dbPool
          ? createPostgresGovernanceWriteStore(dbPool, governanceActionStore)
          : createPassthroughGovernanceWriteStore(governanceActionStore, auditStore),
        dbPool
          ? createPostgresGovernanceTransitionStore(dbPool)
          : createInMemoryGovernanceTransitionStore(governanceActionStore, auditStore),
        verifier,
      ),
      idempotencyStore: createInMemoryIdempotencyStore(),
      containmentEvidence,
      freezeReviewStore: dbPool ? createPostgresFreezeReviewStore(dbPool) : undefined,
    }),
  );
  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
    requestRateLimitMiddleware,
  });
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return {
    server,
    governanceActionStore,
    auditStore,
    verifier,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
  };
}

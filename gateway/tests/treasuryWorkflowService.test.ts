/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { TreasuryWorkflowService } from '../src/core/treasuryWorkflowService';
import type { DownstreamServiceOrchestrator } from '../src/core/serviceOrchestrator';
import { GatewayError } from '../src/errors';

function buildCreateSweepBatchContext(
  overrides: Partial<Parameters<TreasuryWorkflowService['createSweepBatch']>[1]> = {},
): Parameters<TreasuryWorkflowService['createSweepBatch']>[1] {
  return {
    requestContext: {
      requestId: 'req-1',
      correlationId: 'corr-1',
    },
    route: '/api/dashboard-gateway/v1/treasury/sweep-batches',
    method: 'POST',
    session: {
      accountId: 'acct-admin',
      userId: 'uid-admin',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      role: 'admin',
      capabilities: [],
      signerAuthorizations: [],
      issuedAt: 1,
      expiresAt: 2,
    },
    audit: {
      reason: 'Prepare treasury fee sweep batch',
      ticketRef: 'FIN-201',
    },
    ...overrides,
  };
}

function buildCreateSweepBatchInput() {
  return {
    batchKey: 'batch-q2-001',
    accountingPeriodId: 7,
    assetSymbol: 'USDC',
    expectedTotalRaw: '125000000',
  };
}

describe('TreasuryWorkflowService', () => {
  test('audit metadata records both raw and effective treasury capabilities', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: 11, status: 'DRAFT' } }), {
          status: 201,
          headers: {
            'content-type': 'application/json',
          },
        }),
      ),
      probeHealth: jest.fn(),
    };
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new TreasuryWorkflowService(orchestrator, auditLogStore);

    await service.createSweepBatch(buildCreateSweepBatchInput(), buildCreateSweepBatchContext());

    expect(auditLogStore.entries).toHaveLength(1);
    expect(auditLogStore.entries[0].metadata).toEqual(
      expect.objectContaining({
        treasuryPath: '/api/treasury/v1/internal/sweep-batches',
        ticketRef: 'FIN-201',
        reason: 'Prepare treasury fee sweep batch',
      }),
    );
    expect((orchestrator.fetch as jest.Mock).mock.calls[0][1].body).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          gatewayTreasuryCapabilitiesRaw: [],
          gatewayTreasuryCapabilitiesEffective: [],
          signerPolicyResult: 'not_required',
        }),
      }),
    );
  });

  test('createSweepBatch propagates network failures from orchestrator fetch', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockRejectedValue(new Error('network failure')),
      probeHealth: jest.fn(),
    };
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new TreasuryWorkflowService(orchestrator, auditLogStore);

    await expect(
      service.createSweepBatch(buildCreateSweepBatchInput(), buildCreateSweepBatchContext()),
    ).rejects.toThrow('network failure');

    expect(auditLogStore.entries).toHaveLength(0);
  });

  test('createSweepBatch rejects on non-2xx downstream responses', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'TREASURY_INTERNAL_ERROR',
              message: 'internal error',
            },
          }),
          {
            status: 500,
            headers: {
              'content-type': 'application/json',
            },
          },
        ),
      ),
      probeHealth: jest.fn(),
    };
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new TreasuryWorkflowService(orchestrator, auditLogStore);

    await expect(
      service.createSweepBatch(buildCreateSweepBatchInput(), buildCreateSweepBatchContext()),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      statusCode: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'internal error',
      details: expect.objectContaining({
        upstream: 'treasury',
        upstreamStatus: 500,
        upstreamCode: 'TREASURY_INTERNAL_ERROR',
      }),
    });

    expect(auditLogStore.entries).toHaveLength(0);
  });

  test('createSweepBatch rejects malformed downstream payloads', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 201,
          headers: {
            'content-type': 'application/json',
          },
        }),
      ),
      probeHealth: jest.fn(),
    };
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new TreasuryWorkflowService(orchestrator, auditLogStore);

    await expect(
      service.createSweepBatch(buildCreateSweepBatchInput(), buildCreateSweepBatchContext()),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      statusCode: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Failed treasury operation treasury.sweep_batch.created',
      details: expect.objectContaining({
        upstream: 'treasury',
        reason: 'invalid_payload',
      }),
    });

    expect(auditLogStore.entries).toHaveLength(0);
  });

  test('forwards non-empty treasury capabilities into downstream metadata', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: 12, status: 'DRAFT' } }), {
          status: 201,
          headers: {
            'content-type': 'application/json',
          },
        }),
      ),
      probeHealth: jest.fn(),
    };
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new TreasuryWorkflowService(orchestrator, auditLogStore);

    const capabilities = [
      'treasury:prepare',
      'treasury:read',
      'treasury:prepare',
      'governance:write',
    ] as const;

    await service.createSweepBatch(
      {
        ...buildCreateSweepBatchInput(),
        batchKey: 'batch-q2-002',
        accountingPeriodId: 8,
        expectedTotalRaw: '250000000',
      },
      buildCreateSweepBatchContext({
        requestContext: {
          requestId: 'req-2',
          correlationId: 'corr-2',
        },
        session: {
          accountId: 'acct-admin',
          userId: 'uid-admin',
          walletAddress: '0x00000000000000000000000000000000000000bb',
          role: 'admin',
          capabilities: [...capabilities],
          signerAuthorizations: [],
          issuedAt: 1,
          expiresAt: 2,
        },
        audit: {
          reason: 'Prepare second treasury fee sweep batch',
          ticketRef: 'FIN-202',
        },
      }),
    );

    expect((orchestrator.fetch as jest.Mock).mock.calls[0][1].body).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          gatewayTreasuryCapabilitiesRaw: [...capabilities],
          gatewayTreasuryCapabilitiesEffective: ['treasury:prepare', 'treasury:read'],
        }),
      }),
    );
  });
});

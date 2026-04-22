/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import type { OperatorCapability, SignerAuthorization } from '../src/core/authSessionClient';
import { TreasuryWorkflowService } from '../src/core/treasuryWorkflowService';
import type { DownstreamServiceOrchestrator } from '../src/core/serviceOrchestrator';
import { GatewayError } from '../src/errors';

type CreateSweepBatchInput = Parameters<TreasuryWorkflowService['createSweepBatch']>[0];

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

function buildCreateSweepBatchInput(
  overrides: Partial<CreateSweepBatchInput> = {},
): CreateSweepBatchInput {
  return {
    batchKey: 'batch-q2-001',
    accountingPeriodId: 7,
    assetSymbol: 'USDC',
    expectedTotalRaw: '125000000',
    ...overrides,
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

    const input = buildCreateSweepBatchInput();
    await service.createSweepBatch(input, buildCreateSweepBatchContext());

    expect(auditLogStore.entries).toHaveLength(1);
    expect(auditLogStore.entries[0].metadata).toEqual(
      expect.objectContaining({
        treasuryPath: '/api/treasury/v1/internal/sweep-batches',
        ticketRef: 'FIN-201',
        reason: 'Prepare treasury fee sweep batch',
        gatewayTreasuryCapabilitiesRaw: [],
        gatewayTreasuryCapabilitiesEffective: [],
        signerPolicyResult: 'not_required',
      }),
    );
    expect((orchestrator.fetch as jest.Mock).mock.calls[0][1].body).toEqual(
      expect.objectContaining({
        ...input,
        createdBy: 'uid-admin|0x00000000000000000000000000000000000000aa',
        metadata: expect.objectContaining({
          gatewayActorKey: 'account:acct-admin',
          gatewayUserId: 'uid-admin',
          gatewayWalletAddress: '0x00000000000000000000000000000000000000aa',
          gatewayRole: 'admin',
          requestId: 'req-1',
          correlationId: 'corr-1',
          auditReason: 'Prepare treasury fee sweep batch',
          auditTicketRef: 'FIN-201',
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

    const capabilities: OperatorCapability[] = [
      'treasury:prepare',
      'treasury:read',
      // Intentional duplicates to validate effective capability deduplication.
      'treasury:prepare',
      'treasury:read',
      'governance:write',
    ];

    await service.createSweepBatch(
      buildCreateSweepBatchInput({
        batchKey: 'batch-q2-002',
        accountingPeriodId: 8,
        expectedTotalRaw: '250000000',
      }),
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

    const downstreamBody = (orchestrator.fetch as jest.Mock).mock.calls[0][1].body;
    expect(auditLogStore.entries).toHaveLength(1);
    expect(downstreamBody).toEqual(
      expect.objectContaining({
        batchKey: 'batch-q2-002',
        accountingPeriodId: 8,
        assetSymbol: 'USDC',
        expectedTotalRaw: '250000000',
        createdBy: 'uid-admin|0x00000000000000000000000000000000000000bb',
        metadata: expect.objectContaining({
          gatewayTreasuryCapabilitiesRaw: [...capabilities],
          gatewayTreasuryCapabilitiesEffective: ['treasury:prepare', 'treasury:read'],
        }),
      }),
    );
    expect(
      downstreamBody.metadata.gatewayTreasuryCapabilitiesEffective.every((capability: string) =>
        capability.startsWith('treasury:'),
      ),
    ).toBe(true);
    expect(downstreamBody.metadata.gatewayTreasuryCapabilitiesEffective).not.toContain(
      'governance:write',
    );
    expect(auditLogStore.entries[0].metadata).toEqual(
      expect.objectContaining({
        gatewayTreasuryCapabilitiesRaw: [...capabilities],
        gatewayTreasuryCapabilitiesEffective: ['treasury:prepare', 'treasury:read'],
        signerPolicyResult: 'not_required',
      }),
    );
  });

  test('deduplicates treasury capabilities and filters non-treasury capabilities', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: 14, status: 'DRAFT' } }), {
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

    const capabilities: OperatorCapability[] = [
      'governance:write',
      'treasury:read',
      'treasury:prepare',
      'treasury:read',
      'compliance:write',
      'treasury:prepare',
    ];

    await service.createSweepBatch(
      buildCreateSweepBatchInput({
        batchKey: 'batch-q2-003',
        accountingPeriodId: 9,
        expectedTotalRaw: '350000000',
      }),
      buildCreateSweepBatchContext({
        requestContext: {
          requestId: 'req-3',
          correlationId: 'corr-3',
        },
        session: {
          accountId: 'acct-admin',
          userId: 'uid-admin',
          walletAddress: '0x00000000000000000000000000000000000000cc',
          role: 'admin',
          capabilities: [...capabilities],
          signerAuthorizations: [],
          issuedAt: 1,
          expiresAt: 2,
        },
        audit: {
          reason: 'Prepare third treasury fee sweep batch',
          ticketRef: 'FIN-203',
        },
      }),
    );

    const downstreamBody = (orchestrator.fetch as jest.Mock).mock.calls[0][1].body;
    expect(downstreamBody.metadata.gatewayTreasuryCapabilitiesRaw).toEqual([...capabilities]);
    expect(downstreamBody.metadata.gatewayTreasuryCapabilitiesEffective).toEqual([
      'treasury:read',
      'treasury:prepare',
    ]);
    expect(downstreamBody.metadata.gatewayTreasuryCapabilitiesEffective).not.toContain(
      'governance:write',
    );
    expect(downstreamBody.metadata.gatewayTreasuryCapabilitiesEffective).not.toContain(
      'compliance:write',
    );
    expect(auditLogStore.entries[0].metadata).toEqual(
      expect.objectContaining({
        gatewayTreasuryCapabilitiesRaw: [...capabilities],
        gatewayTreasuryCapabilitiesEffective: ['treasury:read', 'treasury:prepare'],
      }),
    );
  });

  test('records authorized signer policy metadata when signer authorization is present', async () => {
    const orchestrator: DownstreamServiceOrchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: 13, status: 'APPROVED' } }), {
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
    const signerBinding: SignerAuthorization = {
      bindingId: 'binding-1',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      actionClass: 'treasury_approve',
      environment: 'production',
      approvedAt: '2026-04-22T10:00:00.000Z',
      approvedBy: 'uid-owner',
      ticketRef: 'FIN-203',
      notes: 'Treasury signer approved',
    };

    await service.createSweepBatch(
      buildCreateSweepBatchInput(),
      buildCreateSweepBatchContext({
        session: {
          accountId: 'acct-admin',
          userId: 'uid-admin',
          walletAddress: '0x00000000000000000000000000000000000000aa',
          role: 'admin',
          capabilities: ['treasury:prepare'],
          signerAuthorizations: [signerBinding],
          issuedAt: 1,
          expiresAt: 2,
        },
        signerPolicy: {
          required: true,
          result: 'authorized',
          actionClass: 'treasury_approve',
          binding: signerBinding,
        },
      }),
    );

    const downstreamBody = (orchestrator.fetch as jest.Mock).mock.calls[0][1].body;
    expect(downstreamBody.metadata).toEqual(
      expect.objectContaining({
        signerPolicyRequired: true,
        signerPolicyResult: 'authorized',
        signerPolicyActionClass: 'treasury_approve',
        signerBindingId: 'binding-1',
        signerBindingEnvironment: 'production',
        signerBindingWallet: '0x00000000000000000000000000000000000000aa',
      }),
    );
    expect(auditLogStore.entries).toHaveLength(1);
    expect(auditLogStore.entries[0].metadata).toEqual(
      expect.objectContaining({
        signerPolicyRequired: true,
        signerPolicyResult: 'authorized',
        signerPolicyActionClass: 'treasury_approve',
        signerBindingId: 'binding-1',
        signerBindingEnvironment: 'production',
        signerBindingWallet: '0x00000000000000000000000000000000000000aa',
      }),
    );
  });
});

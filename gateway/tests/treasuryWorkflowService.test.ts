/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { TreasuryWorkflowService } from '../src/core/treasuryWorkflowService';
import type { DownstreamServiceOrchestrator } from '../src/core/serviceOrchestrator';

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

    await service.createSweepBatch(
      {
        batchKey: 'batch-q2-001',
        accountingPeriodId: 7,
        assetSymbol: 'USDC',
        expectedTotalRaw: '125000000',
      },
      {
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
      },
    );

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
});

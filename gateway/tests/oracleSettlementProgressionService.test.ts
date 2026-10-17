import { fundedBindingFixture } from './helpers/settlementExecutionBindingFixtures';
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { OracleSettlementProgressionService } from '../src/core/oracleSettlementProgressionService';
import type { DownstreamServiceOrchestrator } from '../src/core/serviceOrchestrator';
import type { SettlementService } from '../src/core/settlementService';
import type { SettlementHandoffRecord, SettlementStore } from '../src/core/settlementStore';

const handoff = (phase: string, metadata: Record<string, unknown> = {}) =>
  ({
    executionBinding: fundedBindingFixture(phase),
    sourceApiKeyId: 'platform-main',
    platformHandoffId: '42',
    ricardianHash: `0x${'5'.repeat(64)}`,
    handoffId: 'sth-42',
    tradeId: '9001',
    phase,
    metadata,
    reconciliationStatus: 'pending',
  }) as unknown as SettlementHandoffRecord;

const deployment = {
  chainId: 31337,
  escrowAddress: `0x${'1'.repeat(40)}`,
  usdcAddress: `0x${'2'.repeat(40)}`,
};
const executionRecorder = () =>
  ({
    recordExecutionEvent: jest.fn().mockResolvedValue({}),
  }) as unknown as SettlementService;

describe('OracleSettlementProgressionService', () => {
  it.each([
    ['initial_release_after_custody_and_documents', '/api/oracle/release-stage1'],
    ['inspection_available_standard', '/api/oracle/confirm-inspection-available/standard'],
    [
      'inspection_available_packaged_local',
      '/api/oracle/confirm-inspection-available/packaged-local',
    ],
  ])('maps %s to the authoritative oracle command', async (phase, path) => {
    const store = { getHandoff: jest.fn().mockResolvedValue(handoff(phase)) };
    const orchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, status: 'SUBMITTED' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    };
    const settlementService = executionRecorder();
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      settlementService,
      () => new Date(),
      deployment,
    );

    const result = await service.executeHandoff('sth-42', 'req-42');

    expect(orchestrator.fetch).toHaveBeenCalledWith(
      'oracle',
      expect.objectContaining({
        method: 'POST',
        path,
        body: { tradeId: '9001', requestId: 'req-42', fundedBinding: fundedBindingFixture(phase) },
        authenticated: true,
        readOnly: false,
      }),
    );
    expect(result).toMatchObject({ handoffId: 'sth-42', phase, oraclePath: path });
    expect(result.disposition).toBe('submitted');
    expect(settlementService.recordExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffId: 'sth-42',
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: 'pending',
        providerStatus: 'oracle_submitted',
        requestId: 'req-42',
      }),
    );
  });

  it('classifies a converged initial release as already completed', async () => {
    const store = {
      getHandoff: jest
        .fn()
        .mockResolvedValue(handoff('initial_release_after_custody_and_documents')),
    };
    const orchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            status: 'SUBMITTED',
            idempotent: true,
            txHash: `0x${'a'.repeat(64)}`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      executionRecorder(),
      () => new Date(),
      deployment,
    );

    const result = await service.executeHandoff('sth-42', 'req-42');

    expect(result).toMatchObject({
      disposition: 'already_completed',
      oracle: { idempotent: true, txHash: `0x${'a'.repeat(64)}` },
    });
  });

  it('records confirmed oracle truth without marking it reconciled', async () => {
    const store = {
      getHandoff: jest
        .fn()
        .mockResolvedValue(handoff('initial_release_after_custody_and_documents')),
    };
    const orchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            status: 'CONFIRMED',
            txHash: `0x${'b'.repeat(64)}`,
            blockNumber: 123,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    };
    const settlementService = executionRecorder();
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      settlementService,
      () => new Date(),
      deployment,
    );

    await service.executeHandoff('sth-42', 'req-confirmed');

    expect(settlementService.recordExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'confirmed',
        executionStatus: 'confirmed',
        reconciliationStatus: 'pending',
        providerStatus: 'oracle_confirmed',
        txHash: `0x${'b'.repeat(64)}`,
        metadata: expect.objectContaining({ oracleBlockNumber: 123 }),
      }),
    );
  });

  it('fails closed for governed dispute resolution instead of auto-executing it', async () => {
    const store = { getHandoff: jest.fn().mockResolvedValue(handoff('dispute_resolution')) };
    const orchestrator = { fetch: jest.fn() };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      executionRecorder(),
      () => new Date(),
      deployment,
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(orchestrator.fetch).not.toHaveBeenCalled();
  });

  it.each(['final_release_after_inspection_acceptance', 'final_release_after_notice_deadline'])(
    'rejects unreviewed Oracle-only %s before any remote request or execution event',
    async (phase) => {
      const store = {
        getHandoff: jest.fn().mockResolvedValue(handoff(phase)),
      };
      const orchestrator = { fetch: jest.fn() };
      const recorder = executionRecorder();
      const service = new OracleSettlementProgressionService(
        store as unknown as SettlementStore,
        orchestrator as unknown as DownstreamServiceOrchestrator,
        recorder,
      );

      await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(orchestrator.fetch).not.toHaveBeenCalled();
      expect(recorder.recordExecutionEvent).not.toHaveBeenCalled();
    },
  );

  it('preserves the approved acceptance purpose after the notice window expires', async () => {
    const store = {
      getHandoff: jest.fn().mockResolvedValue(
        handoff('final_release_after_inspection_acceptance', {
          noticeDeadlineAt: '2026-07-17T08:00:00.000Z',
        }),
      ),
    };
    const orchestrator = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, status: 'SUBMITTED' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      executionRecorder(),
      () => new Date('2026-07-17T08:00:01.000Z'),
      deployment,
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(orchestrator.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy handoff is not bound to an on-chain trade id', async () => {
    const store = {
      getHandoff: jest.fn().mockResolvedValue({
        ...handoff('inspection_available_standard'),
        tradeId: 'ORD-000042',
      }),
    };
    const orchestrator = { fetch: jest.fn() };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      executionRecorder(),
      () => new Date(),
      deployment,
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(orchestrator.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the oracle rejects or returns malformed truth', async () => {
    const store = {
      getHandoff: jest
        .fn()
        .mockResolvedValue(handoff('initial_release_after_custody_and_documents')),
    };
    const orchestrator = {
      fetch: jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: false, message: 'wrong state' }), { status: 409 }),
        ),
    };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      executionRecorder(),
      () => new Date(),
      deployment,
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it.each(['TERMINAL_FAILURE', 'EXHAUSTED_NEEDS_REDRIVE', 'PENDING', 'EXECUTING'])(
    'does not complete a handoff when the oracle reports %s',
    async (status) => {
      const store = {
        getHandoff: jest
          .fn()
          .mockResolvedValue(handoff('initial_release_after_custody_and_documents')),
      };
      const orchestrator = {
        fetch: jest.fn().mockResolvedValue(
          new Response(JSON.stringify({ success: status === 'PENDING', status }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      };
      const service = new OracleSettlementProgressionService(
        store as unknown as SettlementStore,
        orchestrator as unknown as DownstreamServiceOrchestrator,
        executionRecorder(),
        () => new Date(),
        deployment,
      );

      await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );
  it('routes an original funded trade only to its approved retained Oracle after cutover', async () => {
    const stored = handoff('initial_release_after_custody_and_documents');
    const fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, status: 'SUBMITTED' }), { status: 200 }),
      );
    const config = {
      ...deployment,
      chainId: 84532,
      escrowAddress: `0x${'6'.repeat(40)}`,
      retainedSettlementRails: [
        {
          ...deployment,
          rpcUrl: 'https://primary.example.test',
          rpcFallbackUrls: ['https://witness.example.test'],
          railManifestSha256: 'a'.repeat(64),
          indexerCoverageUrl: 'https://indexer.example.test',
          reconciliationCoverageUrl: 'https://recon.example.test',
          executionOracleBaseUrl: 'https://retained-oracle.example.test',
        },
      ],
    };
    const create = (value: typeof config) =>
      new OracleSettlementProgressionService(
        { getHandoff: async () => stored } as never,
        { fetch } as never,
        executionRecorder(),
        () => new Date(),
        value,
      );
    await create(config).executeHandoff('sth-42', 'req-42');
    expect(fetch).toHaveBeenCalledWith(
      `retained_oracle:31337:${deployment.escrowAddress}`,
      expect.objectContaining({
        body: expect.objectContaining({ fundedBinding: stored.executionBinding }),
      }),
    );
    fetch.mockClear();
    await expect(
      create({ ...config, retainedSettlementRails: [] }).executeHandoff('sth-42', 'req-42'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing and changed stored bindings before contacting an executor', async () => {
    for (const change of [
      { executionBinding: null },
      { tradeId: '9002' },
      { sourceApiKeyId: 'different-owner' },
      { phase: 'final_release_after_notice_deadline' },
    ]) {
      const fetch = jest.fn();
      const stored = { ...handoff('initial_release_after_custody_and_documents'), ...change };
      const service = new OracleSettlementProgressionService(
        { getHandoff: async () => stored } as never,
        { fetch } as never,
        executionRecorder(),
        () => new Date(),
        deployment,
      );
      await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

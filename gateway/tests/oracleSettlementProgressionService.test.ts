/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { OracleSettlementProgressionService } from '../src/core/oracleSettlementProgressionService';
import type { DownstreamServiceOrchestrator } from '../src/core/serviceOrchestrator';
import type { SettlementHandoffRecord, SettlementStore } from '../src/core/settlementStore';

const handoff = (phase: string, metadata: Record<string, unknown> = {}) =>
  ({
    handoffId: 'sth-42',
    tradeId: '9001',
    phase,
    metadata,
  }) as unknown as SettlementHandoffRecord;

describe('OracleSettlementProgressionService', () => {
  it.each([
    ['initial_release_after_custody_and_documents', '/api/oracle/release-stage1'],
    ['inspection_available_standard', '/api/oracle/confirm-inspection-available/standard'],
    [
      'inspection_available_packaged_local',
      '/api/oracle/confirm-inspection-available/packaged-local',
    ],
    [
      'final_release_after_inspection_acceptance',
      '/api/oracle/finalize-after-inspection-acceptance',
    ],
    ['final_release_after_notice_deadline', '/api/oracle/finalize-trade'],
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
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
    );

    const result = await service.executeHandoff('sth-42', 'req-42');

    expect(orchestrator.fetch).toHaveBeenCalledWith(
      'oracle',
      expect.objectContaining({
        method: 'POST',
        path,
        body: { tradeId: '9001', requestId: 'req-42' },
        authenticated: true,
        readOnly: false,
      }),
    );
    expect(result).toMatchObject({ handoffId: 'sth-42', phase, oraclePath: path });
    expect(result.disposition).toBe('submitted');
  });

  it('classifies a converged final release as already completed', async () => {
    const store = {
      getHandoff: jest.fn().mockResolvedValue(handoff('final_release_after_notice_deadline')),
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
    );

    const result = await service.executeHandoff('sth-42', 'req-42');

    expect(result).toMatchObject({
      disposition: 'already_completed',
      oracle: { idempotent: true, txHash: `0x${'a'.repeat(64)}` },
    });
  });

  it('fails closed for governed dispute resolution instead of auto-executing it', async () => {
    const store = { getHandoff: jest.fn().mockResolvedValue(handoff('dispute_resolution')) };
    const orchestrator = { fetch: jest.fn() };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(orchestrator.fetch).not.toHaveBeenCalled();
  });

  it('can disable oracle-only immediate acceptance release by deployment policy', async () => {
    const store = {
      getHandoff: jest.fn().mockResolvedValue(handoff('final_release_after_inspection_acceptance')),
    };
    const orchestrator = { fetch: jest.fn() };
    const service = new OracleSettlementProgressionService(
      store as unknown as SettlementStore,
      orchestrator as unknown as DownstreamServiceOrchestrator,
      false,
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(orchestrator.fetch).not.toHaveBeenCalled();
  });

  it('falls back to deadline finalization after the notice window expires', async () => {
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
      false,
      () => new Date('2026-07-17T08:00:01.000Z'),
    );

    const result = await service.executeHandoff('sth-42', 'req-42');

    expect(orchestrator.fetch).toHaveBeenCalledWith(
      'oracle',
      expect.objectContaining({ path: '/api/oracle/finalize-trade' }),
    );
    expect(result).toMatchObject({
      phase: 'final_release_after_notice_deadline',
      oraclePath: '/api/oracle/finalize-trade',
    });
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
    );

    await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(orchestrator.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the oracle rejects or returns malformed truth', async () => {
    const store = {
      getHandoff: jest.fn().mockResolvedValue(handoff('final_release_after_inspection_acceptance')),
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
        getHandoff: jest.fn().mockResolvedValue(handoff('final_release_after_notice_deadline')),
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
      );

      await expect(service.executeHandoff('sth-42', 'req-42')).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );
});

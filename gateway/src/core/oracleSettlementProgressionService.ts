/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import type { DownstreamServiceOrchestrator } from './serviceOrchestrator';
import type { SettlementHandoffRecord, SettlementStore } from './settlementStore';

const ORACLE_PATH_BY_PHASE = {
  initial_release_after_custody_and_documents: '/api/oracle/release-stage1',
  inspection_available_standard: '/api/oracle/confirm-inspection-available/standard',
  inspection_available_packaged_local: '/api/oracle/confirm-inspection-available/packaged-local',
  final_release_after_inspection_acceptance: '/api/oracle/finalize-after-inspection-acceptance',
  final_release_after_notice_deadline: '/api/oracle/finalize-trade',
} as const;

type ExecutableSettlementPhase = keyof typeof ORACLE_PATH_BY_PHASE;

const ACCEPTED_ORACLE_STATUSES = new Set(['SUBMITTED', 'CONFIRMED']);

export interface OracleSettlementProgressionResult {
  handoffId: string;
  phase: ExecutableSettlementPhase;
  oraclePath: string;
  oracle: Record<string, unknown>;
}

export class OracleSettlementProgressionService {
  constructor(
    private readonly settlementStore: SettlementStore,
    private readonly orchestrator: DownstreamServiceOrchestrator,
    private readonly immediateInspectionAcceptanceEnabled = true,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async executeHandoff(
    handoffId: string,
    requestId: string,
  ): Promise<OracleSettlementProgressionResult> {
    const handoff = await this.settlementStore.getHandoff(handoffId);
    if (!handoff) {
      throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', { handoffId });
    }

    if (!/^\d+$/.test(handoff.tradeId)) {
      throw new GatewayError(
        409,
        'CONFLICT',
        'Settlement handoff is not bound to a numeric on-chain trade identifier',
        { handoffId, tradeId: handoff.tradeId },
      );
    }

    const phase = this.requireExecutablePhase(handoff);
    const path = ORACLE_PATH_BY_PHASE[phase];
    const response = await this.orchestrator.fetch('oracle', {
      method: 'POST',
      path,
      body: { tradeId: handoff.tradeId, requestId },
      readOnly: false,
      authenticated: true,
      operation: `oracle:settlement:${phase}`,
      requestContext: { requestId, correlationId: requestId },
    });
    const body = await this.readResponseBody(response, handoff);

    const oracleStatus = typeof body.status === 'string' ? body.status : null;
    if (
      !response.ok ||
      body.success !== true ||
      oracleStatus === null ||
      !ACCEPTED_ORACLE_STATUSES.has(oracleStatus)
    ) {
      throw new GatewayError(
        502,
        'UPSTREAM_UNAVAILABLE',
        'Oracle did not submit the settlement progression transaction',
        { handoffId, phase, upstreamStatus: response.status, oracleStatus },
      );
    }

    return { handoffId, phase, oraclePath: path, oracle: body };
  }

  private requireExecutablePhase(handoff: SettlementHandoffRecord): ExecutableSettlementPhase {
    if (
      handoff.phase === 'final_release_after_inspection_acceptance' &&
      !this.immediateInspectionAcceptanceEnabled
    ) {
      const noticeDeadline = this.resolveNoticeDeadline(handoff);
      if (noticeDeadline && noticeDeadline.getTime() <= this.now().getTime()) {
        return 'final_release_after_notice_deadline';
      }

      throw new GatewayError(
        409,
        'CONFLICT',
        'Immediate inspection-acceptance release is disabled until buyer-signed on-chain acceptance is available. Deadline finalization will become available when the inspection notice window expires.',
        {
          handoffId: handoff.handoffId,
          phase: handoff.phase,
          noticeDeadlineAt: noticeDeadline?.toISOString() ?? null,
        },
      );
    }

    if (handoff.phase in ORACLE_PATH_BY_PHASE) {
      return handoff.phase as ExecutableSettlementPhase;
    }

    throw new GatewayError(
      409,
      'CONFLICT',
      'This settlement phase does not support automatic oracle progression',
      { handoffId: handoff.handoffId, phase: handoff.phase },
    );
  }

  private resolveNoticeDeadline(handoff: SettlementHandoffRecord): Date | null {
    const value = handoff.metadata.noticeDeadlineAt;
    if (typeof value !== 'string') return null;

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }

  private async readResponseBody(
    response: Response,
    handoff: SettlementHandoffRecord,
  ): Promise<Record<string, unknown>> {
    try {
      const body = (await response.json()) as unknown;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
    } catch {
      // The normalized error below avoids returning upstream response bodies.
    }

    throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Oracle returned an invalid response', {
      handoffId: handoff.handoffId,
      phase: handoff.phase,
      oracleStatus: response.status,
    });
  }
}

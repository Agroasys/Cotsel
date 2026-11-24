/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reconciliation containments with their signed evidence verified (Cotsel#951).
 *
 * A containment is the freeze request for one trade. Its evidence is
 * `verified` only when the run that opened it verifies against its signed
 * manifest, every finding the incident cites is a verified finding of that run,
 * and the clean run that cleared it (if any) verifies too. Governance uses this
 * before preparing a trade unpause, and the dashboard shows it. The rows and
 * seal come from reconciliation's internal service; the gateway verifies them
 * itself, so a tampered reply cannot pass.
 */
import {
  verifyContainmentBundle,
  type ClassifiedFinding,
} from '@agroasys/shared-db/reconciliationEvidence';
import type { ReconciliationEvidenceConfig } from '../config/reconciliationEvidenceConfig';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';

export type ContainmentEvidenceStatus = 'verified' | 'failed' | 'unsigned';

export interface ContainmentFinding {
  digest: string;
  mismatchCode: string | null;
  comparedField: string | null;
  status: ClassifiedFinding['status'];
}

export interface VerifiedContainment {
  tradeId: string;
  incidentReference: string;
  state: 'CONTAINED' | 'RECONCILED_PENDING_APPROVAL' | 'RELEASED';
  openedRunKey: string;
  openedAt: string;
  qualifyingCodes: string[];
  clearedRunKey: string | null;
  rulesVersion: string | null;
  findings: ContainmentFinding[];
  evidence: { status: ContainmentEvidenceStatus; reason: string | null };
}

export interface ContainmentEvidenceService {
  list(): Promise<VerifiedContainment[]>;
  get(tradeId: string): Promise<VerifiedContainment | null>;
  /** Throws unless the trade's containment exists and its evidence verifies. */
  requireVerified(tradeId: string): Promise<VerifiedContainment>;
  close(): Promise<void>;
}

type RawBundle = Parameters<typeof verifyContainmentBundle>[0];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural check of an untrusted bundle; verification decides the rest. */
function isBundle(value: unknown): value is RawBundle {
  if (!isRecord(value) || !isRecord(value.containment) || !isRecord(value.opening)) return false;
  const row = value.containment;
  return (
    typeof row.trade_id === 'string' &&
    typeof row.incident_reference === 'string' &&
    typeof row.state === 'string' &&
    typeof row.opened_run_key === 'string' &&
    typeof row.opened_at === 'string' &&
    Array.isArray(row.qualifying_codes) &&
    (row.cleared_run_key === null || typeof row.cleared_run_key === 'string') &&
    typeof value.opening.runKey === 'string' &&
    (value.clearing === null || isRecord(value.clearing))
  );
}

function present(
  bundle: RawBundle,
  keys: ReconciliationEvidenceConfig['publicKeys'],
): VerifiedContainment {
  const row = bundle.containment;
  return {
    tradeId: row.trade_id,
    incidentReference: row.incident_reference,
    state: row.state,
    openedRunKey: row.opened_run_key,
    openedAt: new Date(`${row.opened_at}Z`).toISOString(),
    qualifyingCodes: row.qualifying_codes,
    clearedRunKey: row.cleared_run_key,
    rulesVersion: row.evidence?.rules?.version ?? null,
    ...verifyContainmentBundle(bundle, keys),
  };
}

function unavailable(detail: string): GatewayError {
  return new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Reconciliation evidence is unavailable', {
    reason: 'reconciliation_evidence_unavailable',
    detail,
  });
}

export function createContainmentEvidenceService(
  config: ReconciliationEvidenceConfig,
  fetchImpl: typeof fetch = fetch,
): ContainmentEvidenceService {
  async function read(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        signal: AbortSignal.timeout(config.timeoutMs),
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw unavailable('request_failed');
    }
    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    // Only reconciliation's own "no such containment" is a not-found. Any
    // other 404 (an image without /containments) means evidence is unavailable.
    if (response.status === 404) {
      if (isRecord(body) && body.error === 'containment_not_found') return null;
      throw unavailable('endpoint_missing');
    }
    if (!response.ok) throw unavailable(`status_${response.status}`);
    if (body === undefined) throw unavailable('invalid_json');
    return body;
  }

  function malformed(tradeId: string): VerifiedContainment {
    // Never a pass: a reply the gateway cannot read is not evidence.
    return {
      tradeId,
      incidentReference: '',
      state: 'CONTAINED',
      openedRunKey: '',
      openedAt: new Date(0).toISOString(),
      qualifyingCodes: [],
      clearedRunKey: null,
      rulesVersion: null,
      findings: [],
      evidence: { status: 'failed', reason: 'bundle_malformed' },
    };
  }

  const service: ContainmentEvidenceService = {
    async list() {
      const body = await read('/containments');
      const items = isRecord(body) && Array.isArray(body.items) ? body.items : null;
      if (!items) throw unavailable('list_malformed');
      return items.map((item) =>
        isBundle(item)
          ? present(item, config.publicKeys)
          : malformed(
              isRecord(item) && isRecord(item.containment) ? String(item.containment.trade_id) : '',
            ),
      );
    },

    async get(tradeId) {
      const body = await read(`/containments/${encodeURIComponent(tradeId)}`);
      if (body === null) return null;
      if (!isBundle(body) || body.containment.trade_id !== tradeId) return malformed(tradeId);
      return present(body, config.publicKeys);
    },

    async requireVerified(tradeId) {
      const containment = await service.get(tradeId);
      if (!containment) {
        throw new GatewayError(409, 'CONFLICT', 'The trade has no reconciliation containment', {
          reason: 'containment_not_found',
          tradeId,
        });
      }
      if (containment.evidence.status !== 'verified') {
        Logger.error('Trade unpause refused: reconciliation evidence does not verify', {
          tradeId,
          errorCode: 'RECONCILIATION_EVIDENCE_INVALID',
          reason: containment.evidence.reason,
        });
        throw new GatewayError(
          409,
          'CONFLICT',
          'The containment evidence for this trade does not verify against its signed manifest',
          {
            reason:
              containment.evidence.status === 'unsigned'
                ? 'reconciliation_evidence_unsigned'
                : 'reconciliation_evidence_invalid',
            tradeId,
            detail: containment.evidence.reason,
          },
        );
      }
      return containment;
    },

    close: async () => undefined,
  };
  return service;
}

/** For a gateway without reconciliation evidence configured: every check fails closed. */
export const UNCONFIGURED_CONTAINMENT_EVIDENCE: ContainmentEvidenceService = {
  list: async () => {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Reconciliation evidence is not configured',
      {
        reason: 'reconciliation_evidence_unconfigured',
      },
    );
  },
  get: async () => {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Reconciliation evidence is not configured',
      {
        reason: 'reconciliation_evidence_unconfigured',
      },
    );
  },
  requireVerified: async () => {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Reconciliation evidence is not configured',
      {
        reason: 'reconciliation_evidence_unconfigured',
      },
    );
  },
  close: async () => undefined,
};

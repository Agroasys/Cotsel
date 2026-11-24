import { randomBytes } from 'node:crypto';
import { verifyActionEvidence } from '@agroasys/shared-db/actionEvidence';
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
  validateContainmentPageOptions,
  type ContainmentPageOptions,
} from '@agroasys/shared-db/reconciliationEvidence';
import {
  verifyContainmentRecovery,
  type ContainmentRecoveryDecision,
} from '@agroasys/shared-db/containmentRecovery';
import { decodeBytes32String, encodeBytes32String, keccak256, toUtf8Bytes } from 'ethers';
import {
  buildFreezeRequest,
  verifyFreezeRequestBundle,
  type FreezeRequest,
} from '@agroasys/shared-db/freezeRequests';
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
  proof?: RawBundle | null;
  freezeRequestId?: string | null;
}

export interface ContainmentEvidenceService {
  list(): Promise<VerifiedContainment[]>;
  listPage(
    options?: ContainmentPageOptions,
  ): Promise<{ items: VerifiedContainment[]; nextCursor: string | null }>;
  freezeRequest(requestId: string): Promise<FreezeRequest>;
  get(tradeId: string): Promise<VerifiedContainment | null>;
  /** Throws unless the trade's containment exists and its evidence verifies. */
  requireVerified(tradeId: string): Promise<VerifiedContainment>;
  /**
   * Decides a trade-scoped unpause from signed evidence (review R02, Q1/Q2).
   * Returns the decision when the unpause may proceed; throws otherwise.
   */
  requireRecovery(input: {
    tradeId: string;
    /** The escrow proposal's bytes32 incidentRef. */
    incidentRef: string;
  }): Promise<RecoveryDecision>;
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

function present(bundle: RawBundle, config: ReconciliationEvidenceConfig): VerifiedContainment {
  const row = bundle.containment;
  const checked = verifyContainmentBundle(bundle, config.publicKeys, { context: config.context });
  let freezeRequestId: string | null = null;
  if (checked.evidence.status === 'verified') {
    const opening = bundle.recovery?.runs[row.opened_run_key] as RawBundle['opening'] | undefined;
    const manifest = opening?.seal?.manifest;
    const entry = manifest?.containments?.find(
      (item) => item.tradeId === row.trade_id && item.incidentReference === row.incident_reference,
    );
    if (manifest && entry) freezeRequestId = buildFreezeRequest(manifest, entry).requestId;
  }
  return {
    tradeId: row.trade_id,
    incidentReference: row.incident_reference,
    state: row.state,
    openedRunKey: row.opened_run_key,
    openedAt: new Date(`${row.opened_at}Z`).toISOString(),
    qualifyingCodes: row.qualifying_codes,
    clearedRunKey: row.cleared_run_key,
    rulesVersion: bundle.recovery?.latest.seal?.manifest.rules.version ?? null,
    ...checked,
    proof: bundle,
    freezeRequestId,
  };
}

function unavailable(detail: string): GatewayError {
  return new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Reconciliation evidence is unavailable', {
    reason: 'reconciliation_evidence_unavailable',
    detail,
  });
}

export type RecoveryDecision = Exclude<ContainmentRecoveryDecision, { decision: 'refused' }>;

/** The escrow's incidentRef carries a reference literally or as its keccak256. */
export function incidentRefMatches(incidentRef: string, incidentReference: string): boolean {
  const onchain = incidentRef.toLowerCase();
  let literal: string | null = null;
  try {
    literal = encodeBytes32String(incidentReference).toLowerCase();
  } catch {
    literal = null;
  }
  return onchain === literal || onchain === keccak256(toUtf8Bytes(incidentReference)).toLowerCase();
}

function namesReconciliationIncident(incidentRef: string): boolean {
  try {
    return decodeBytes32String(incidentRef).startsWith('RECON-');
  } catch {
    return false;
  }
}

/** Refusal status: stale or unreachable evidence is 503, a failed check 409. */
function recoveryRefusal(
  result: Extract<ContainmentRecoveryDecision, { decision: 'refused' }>,
  tradeId: string,
): GatewayError {
  const stale = result.reason === 'reconciliation_evidence_stale';
  return new GatewayError(
    stale ? 503 : 409,
    stale ? 'UPSTREAM_UNAVAILABLE' : 'CONFLICT',
    stale
      ? 'Reconciliation evidence is older than the allowed age; the unpause waits for a fresh sealed run'
      : 'The trade-scoped unpause is not supported by verified reconciliation evidence',
    { reason: result.reason, detail: result.detail, tradeId },
  );
}

export function createContainmentEvidenceService(
  config: ReconciliationEvidenceConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
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

  async function readAction(resource: string): Promise<unknown> {
    const challenge = randomBytes(32).toString('hex');
    const body = await read(`${resource}?challenge=${challenge}`);
    if (
      !verifyActionEvidence(body, {
        challenge,
        resource,
        context: config.context,
        publicKeys: config.publicKeys,
        now: now(),
      })
    )
      throw unavailable('action_attestation_invalid');
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
    async freezeRequest(requestId) {
      if (!/^[a-f0-9]{64}$/.test(requestId))
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Invalid freeze request id');
      const raw = await readAction(`/freeze-requests/${requestId}`);
      const result = verifyFreezeRequestBundle(raw, config.publicKeys, config.context, {
        now: now(),
        maxAgeSeconds: config.maxAgeSeconds,
      });
      if (!result.ok && result.reason === 'reconciliation_evidence_stale')
        throw unavailable(result.reason);
      if (!result.ok || result.request.requestId !== requestId)
        throw new GatewayError(409, 'CONFLICT', 'The freeze request evidence does not verify', {
          reason: 'reconciliation_evidence_invalid',
          detail: result.ok ? 'request_id_mismatch' : result.reason,
        });
      return result.request;
    },
    async list() {
      return (await service.listPage()).items;
    },

    async listPage(options = {}) {
      try {
        validateContainmentPageOptions(options);
      } catch {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Invalid containment page or cursor');
      }
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      if (options.cursor !== undefined) query.set('cursor', options.cursor);
      const body = await read(`/containments${query.size ? `?${query}` : ''}`);
      const items = isRecord(body) && Array.isArray(body.items) ? body.items : null;
      if (
        !items ||
        !isRecord(body) ||
        !(body.nextCursor === null || typeof body.nextCursor === 'string')
      )
        throw unavailable('list_malformed');
      return {
        nextCursor: body.nextCursor,
        items: items.map((item) =>
          isBundle(item)
            ? present(item, config)
            : malformed(
                isRecord(item) && isRecord(item.containment)
                  ? String(item.containment.trade_id)
                  : '',
              ),
        ),
      };
    },

    async get(tradeId) {
      const body = await read(`/containments/${encodeURIComponent(tradeId)}`);
      if (body === null) return null;
      if (!isBundle(body) || body.containment.trade_id !== tradeId) return malformed(tradeId);
      return present(body, config);
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

    async requireRecovery({ tradeId, incidentRef }) {
      const bundle = await readAction(`/containments/${encodeURIComponent(tradeId)}/recovery`);
      if (bundle === null) throw unavailable('no_sealed_run');
      const result = verifyContainmentRecovery(bundle, {
        publicKeys: config.publicKeys,
        context: config.context,
        maxAgeSeconds: config.maxAgeSeconds,
        now: now(),
        expectedTradeId: tradeId,
        matchesIncident: (reference) => incidentRefMatches(incidentRef, reference),
        incidentIsReconciliation: namesReconciliationIncident(incidentRef),
      });
      if (result.decision === 'refused') {
        Logger.error('Trade unpause refused on reconciliation evidence', {
          tradeId,
          errorCode: 'RECONCILIATION_RECOVERY_REFUSED',
          reason: result.reason,
          details: result.detail,
        });
        throw recoveryRefusal(result, tradeId);
      }
      return result;
    },

    close: async () => undefined,
  };
  return service;
}

/** For a gateway without reconciliation evidence configured: every check fails closed. */
export const UNCONFIGURED_CONTAINMENT_EVIDENCE: ContainmentEvidenceService = {
  freezeRequest: async () => {
    throw unavailable('reconciliation_evidence_unconfigured');
  },
  listPage: async () => {
    throw unavailable('reconciliation_evidence_unconfigured');
  },
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
  requireRecovery: async () => {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Reconciliation evidence is not configured',
      { reason: 'reconciliation_evidence_unconfigured' },
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

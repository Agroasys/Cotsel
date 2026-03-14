/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import type { ComplianceDecisionRecord, ComplianceStore, OracleProgressionBlockRecord } from './complianceStore';
import type { EvidenceLink } from './governanceStore';
import type { DashboardTradeRecord, TradeReadReader } from './tradeReadService';
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import { GatewayError } from '../errors';
import {
  EvidenceBundleManifestRecord,
  EvidenceBundleStore,
} from './evidenceBundleStore';

const GATEWAY_BASE_PATH = '/api/dashboard-gateway/v1';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function buildGatewayHref(path: string): string {
  return `${GATEWAY_BASE_PATH}${path}`;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  values.forEach((value) => {
    if (!value) {
      return;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latestMs = parsed;
      latest = value;
    }
  });

  return latest;
}

export interface EvidenceBundleArtifactReference {
  artifactId: string;
  type: string;
  title: string;
  format: string;
  href: string | null;
  available: boolean;
  digest: string | null;
  unavailableReason?: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceBundleEvidenceReference {
  sourceType: 'compliance_decision' | 'oracle_progression_block';
  sourceId: string;
  kind: EvidenceLink['kind'];
  uri: string;
  note?: string;
  capturedAt: string;
  actorRole: string;
  actorWallet: string;
}

export interface EvidenceBundleManifest {
  bundleId: string;
  tradeId: string;
  manifestDigest: string;
  generatedAt: string;
  generatedBy: {
    userId: string;
    walletAddress: string;
    role: string;
  };
  signed: false;
  signature: null;
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
  degradedReason?: string;
  trade: {
    id: string;
    status: DashboardTradeRecord['status'];
    createdAt: string;
    updatedAt: string;
    ricardianHash: string | null;
    complianceStatus: DashboardTradeRecord['complianceStatus'];
    settlementHandoffId: string | null;
  };
  artifactReferences: EvidenceBundleArtifactReference[];
  evidenceReferences: EvidenceBundleEvidenceReference[];
}

export interface EvidenceBundleGenerationInput {
  tradeId: string;
  principal: GatewayPrincipal;
  requestContext: RequestContext;
}

export interface EvidenceBundleService {
  generate(input: EvidenceBundleGenerationInput): Promise<EvidenceBundleManifest>;
  get(bundleId: string): Promise<EvidenceBundleManifest | null>;
}

export class GatewayEvidenceBundleService implements EvidenceBundleService {
  constructor(
    private readonly store: EvidenceBundleStore,
    private readonly tradeReadService: TradeReadReader,
    private readonly complianceStore: ComplianceStore,
    private readonly ricardianBaseUrl?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async generate(input: EvidenceBundleGenerationInput): Promise<EvidenceBundleManifest> {
    const trade = await this.tradeReadService.getTrade(input.tradeId);
    if (!trade) {
      throw new GatewayError(404, 'NOT_FOUND', 'Trade not found for evidence bundle generation', {
        tradeId: input.tradeId,
      });
    }

    const queriedAt = this.now().toISOString();
    const [tradeStatus, decisions, oracleProgressionBlock] = await Promise.all([
      this.complianceStore.getTradeStatus(trade.id),
      this.collectTradeDecisions(trade.id),
      this.complianceStore.getOracleProgressionBlock(trade.id),
    ]);

    const bundleId = randomUUID();
    const generatedAt = queriedAt;
    const evidenceReferences = this.buildEvidenceReferences(decisions, oracleProgressionBlock);
    const artifactReferences = this.buildArtifactReferences({
      bundleId,
      trade,
      tradeHasCompliance: tradeStatus !== null || decisions.length > 0,
    });
    const degradedReason = this.resolveDegradedReason(trade);
    const manifestWithoutDigest = {
      bundleId,
      tradeId: trade.id,
      generatedAt,
      generatedBy: {
        userId: input.principal.session.userId,
        walletAddress: input.principal.session.walletAddress,
        role: input.principal.session.role,
      },
      signed: false as const,
      signature: null,
      sourceFreshAt: latestTimestamp([
        trade.updatedAt,
        trade.settlement?.updatedAt ?? null,
        tradeStatus?.updatedAt,
        oracleProgressionBlock?.updatedAt,
        ...decisions.map((decision) => decision.decidedAt),
      ]),
      queriedAt,
      available: degradedReason ? false : true,
      ...(degradedReason ? { degradedReason } : {}),
      trade: {
        id: trade.id,
        status: trade.status,
        createdAt: trade.createdAt,
        updatedAt: trade.updatedAt,
        ricardianHash: trade.ricardianHash || null,
        complianceStatus: trade.complianceStatus,
        settlementHandoffId: trade.settlement?.handoffId ?? null,
      },
      artifactReferences,
      evidenceReferences,
    };

    const manifestDigest = sha256Digest(manifestWithoutDigest);
    const manifest: EvidenceBundleManifest = {
      manifestDigest,
      ...manifestWithoutDigest,
    };

    await this.store.save({
      bundleId,
      tradeId: trade.id,
      manifestDigest,
      ricardianHash: trade.ricardianHash || null,
      generatedAt,
      generatedBy: manifest.generatedBy,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    return manifest;
  }

  async get(bundleId: string): Promise<EvidenceBundleManifest | null> {
    const stored = await this.store.get(bundleId);
    if (!stored) {
      return null;
    }

    return stored.manifest as unknown as EvidenceBundleManifest;
  }

  private async collectTradeDecisions(tradeId: string): Promise<ComplianceDecisionRecord[]> {
    const items: ComplianceDecisionRecord[] = [];
    let cursor: string | undefined;

    while (items.length < 200) {
      const page = await this.complianceStore.listTradeDecisions({
        tradeId,
        limit: 50,
        cursor,
      });

      items.push(...page.items);

      if (!page.nextCursor) {
        break;
      }

      cursor = page.nextCursor;
    }

    return items;
  }

  private buildArtifactReferences(input: {
    bundleId: string;
    trade: DashboardTradeRecord;
    tradeHasCompliance: boolean;
  }): EvidenceBundleArtifactReference[] {
    const artifacts: EvidenceBundleArtifactReference[] = [
      {
        artifactId: 'bundle-metadata',
        type: 'bundle_metadata',
        title: 'Evidence bundle metadata',
        format: 'application/json',
        href: buildGatewayHref(`/evidence/bundles/${input.bundleId}`),
        available: true,
        digest: null,
      },
      {
        artifactId: 'bundle-manifest',
        type: 'bundle_manifest',
        title: 'Evidence bundle manifest download',
        format: 'application/json',
        href: buildGatewayHref(`/evidence/bundles/${input.bundleId}/download`),
        available: true,
        digest: null,
      },
      {
        artifactId: 'trade-detail',
        type: 'trade_snapshot',
        title: 'Gateway trade detail snapshot',
        format: 'application/json',
        href: buildGatewayHref(`/trades/${encodeURIComponent(input.trade.id)}`),
        available: true,
        digest: null,
      },
      {
        artifactId: 'compliance-status',
        type: 'compliance_status',
        title: 'Gateway compliance trade status',
        format: 'application/json',
        href: input.tradeHasCompliance
          ? buildGatewayHref(`/compliance/trades/${encodeURIComponent(input.trade.id)}`)
          : null,
        available: input.tradeHasCompliance,
        digest: null,
        ...(input.tradeHasCompliance ? {} : { unavailableReason: 'No compliance status exists for this trade' }),
      },
      {
        artifactId: 'compliance-decisions',
        type: 'compliance_decision_history',
        title: 'Gateway compliance decision history',
        format: 'application/json',
        href: input.tradeHasCompliance
          ? buildGatewayHref(`/compliance/trades/${encodeURIComponent(input.trade.id)}/decisions`)
          : null,
        available: input.tradeHasCompliance,
        digest: null,
        ...(input.tradeHasCompliance ? {} : { unavailableReason: 'No compliance decision history exists for this trade' }),
      },
    ];

    if (input.trade.ricardianHash) {
      artifacts.push({
        artifactId: 'ricardian-document',
        type: 'ricardian_document',
        title: 'Ricardian document lookup by hash',
        format: 'application/json',
        href: this.ricardianBaseUrl
          ? `${this.ricardianBaseUrl}/hash/${encodeURIComponent(input.trade.ricardianHash)}`
          : null,
        available: Boolean(this.ricardianBaseUrl),
        digest: input.trade.ricardianHash,
        ...(this.ricardianBaseUrl ? {} : { unavailableReason: 'GATEWAY_RICARDIAN_BASE_URL is not configured' }),
        metadata: {
          ricardianHash: input.trade.ricardianHash,
        },
      });
    }

    return artifacts;
  }

  private buildEvidenceReferences(
    decisions: ComplianceDecisionRecord[],
    oracleProgressionBlock: OracleProgressionBlockRecord | null,
  ): EvidenceBundleEvidenceReference[] {
    const references: EvidenceBundleEvidenceReference[] = [];

    decisions.forEach((decision) => {
      decision.audit.evidenceLinks.forEach((link) => {
        references.push({
          sourceType: 'compliance_decision',
          sourceId: decision.decisionId,
          kind: link.kind,
          uri: link.uri,
          ...(link.note ? { note: link.note } : {}),
          capturedAt: decision.decidedAt,
          actorRole: decision.audit.actorRole,
          actorWallet: decision.audit.actorWallet,
        });
      });
    });

    if (oracleProgressionBlock) {
      oracleProgressionBlock.audit.evidenceLinks.forEach((link) => {
        references.push({
          sourceType: 'oracle_progression_block',
          sourceId: oracleProgressionBlock.tradeId,
          kind: link.kind,
          uri: link.uri,
          ...(link.note ? { note: link.note } : {}),
          capturedAt: oracleProgressionBlock.updatedAt,
          actorRole: oracleProgressionBlock.audit.actorRole,
          actorWallet: oracleProgressionBlock.audit.actorWallet,
        });
      });
    }

    return references;
  }

  private resolveDegradedReason(trade: DashboardTradeRecord): string | undefined {
    if (trade.ricardianHash && !this.ricardianBaseUrl) {
      return 'GATEWAY_RICARDIAN_BASE_URL is not configured';
    }

    return undefined;
  }
}

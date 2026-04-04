"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayEvidenceBundleService = void 0;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const errors_1 = require("../errors");
const GATEWAY_BASE_PATH = '/api/dashboard-gateway/v1';
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}
function sha256Digest(value) {
    return `sha256:${(0, crypto_1.createHash)('sha256').update(stableStringify(value)).digest('hex')}`;
}
function buildGatewayHref(path) {
    return `${GATEWAY_BASE_PATH}${path}`;
}
function latestTimestamp(values) {
    let latest = null;
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
function combineDegradedReasons(reasons) {
    const values = [...new Set(reasons.filter((reason) => Boolean(reason?.trim())).map((reason) => reason.trim()))];
    if (values.length === 0) {
        return undefined;
    }
    return values.join('; ');
}
class GatewayEvidenceBundleService {
    constructor(store, tradeReadService, complianceStore, ricardianBaseUrl, now = () => new Date()) {
        this.store = store;
        this.tradeReadService = tradeReadService;
        this.complianceStore = complianceStore;
        this.ricardianBaseUrl = ricardianBaseUrl;
        this.now = now;
    }
    async generate(input) {
        const trade = await this.tradeReadService.getTrade(input.tradeId);
        if (!trade) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Trade not found for evidence bundle generation', {
                tradeId: input.tradeId,
            });
        }
        const queriedAt = this.now().toISOString();
        const [tradeStatusResult, decisionsResult, oracleProgressionBlockResult] = await Promise.allSettled([
            this.complianceStore.getTradeStatus(trade.id),
            this.collectTradeDecisions(trade.id),
            this.complianceStore.getOracleProgressionBlock(trade.id),
        ]);
        const tradeStatus = tradeStatusResult.status === 'fulfilled' ? tradeStatusResult.value : null;
        const decisions = decisionsResult.status === 'fulfilled' ? decisionsResult.value : [];
        const oracleProgressionBlock = oracleProgressionBlockResult.status === 'fulfilled'
            ? oracleProgressionBlockResult.value
            : null;
        const bundleId = (0, crypto_1.randomUUID)();
        const generatedAt = queriedAt;
        const evidenceReferences = this.buildEvidenceReferences(decisions, oracleProgressionBlock);
        const artifactReferences = this.buildArtifactReferences({
            bundleId,
            trade,
            tradeHasCompliance: tradeStatus !== null || decisions.length > 0,
        });
        const degradedReason = combineDegradedReasons([
            this.resolveDegradedReason(trade),
            tradeStatusResult.status === 'rejected' ? this.describeDegradedReason(tradeStatusResult.reason) : undefined,
            decisionsResult.status === 'rejected' ? this.describeDegradedReason(decisionsResult.reason) : undefined,
            oracleProgressionBlockResult.status === 'rejected'
                ? this.describeDegradedReason(oracleProgressionBlockResult.reason)
                : undefined,
        ]);
        const manifestWithoutDigest = {
            bundleId,
            tradeId: trade.id,
            generatedAt,
            generatedBy: {
                userId: input.principal.session.userId,
                walletAddress: input.principal.session.walletAddress,
                role: input.principal.session.role,
            },
            signed: false,
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
        const manifest = {
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
            manifest: manifest,
        });
        return manifest;
    }
    async get(bundleId) {
        const stored = await this.store.get(bundleId);
        if (!stored) {
            return null;
        }
        return stored.manifest;
    }
    describeDegradedReason(error) {
        if (error instanceof Error && error.message.trim().length > 0) {
            return error.message;
        }
        return 'Evidence source is unavailable';
    }
    async collectTradeDecisions(tradeId) {
        const items = [];
        let cursor;
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
    buildArtifactReferences(input) {
        const artifacts = [
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
                href: buildGatewayHref(`/ricardian/${encodeURIComponent(input.trade.id)}`),
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
    buildEvidenceReferences(decisions, oracleProgressionBlock) {
        const references = [];
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
    resolveDegradedReason(trade) {
        if (trade.ricardianHash && !this.ricardianBaseUrl) {
            return 'GATEWAY_RICARDIAN_BASE_URL is not configured';
        }
        return undefined;
    }
}
exports.GatewayEvidenceBundleService = GatewayEvidenceBundleService;
//# sourceMappingURL=evidenceBundleService.js.map
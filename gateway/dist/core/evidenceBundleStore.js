"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPostgresEvidenceBundleStore = createPostgresEvidenceBundleStore;
exports.createInMemoryEvidenceBundleStore = createInMemoryEvidenceBundleStore;
function cloneManifest(record) {
    return {
        ...record,
        generatedBy: { ...record.generatedBy },
        manifest: JSON.parse(JSON.stringify(record.manifest)),
    };
}
function mapRow(row) {
    return {
        bundleId: row.bundleId,
        tradeId: row.tradeId,
        manifestDigest: row.manifestDigest,
        ricardianHash: row.ricardianHash,
        generatedAt: row.generatedAt.toISOString(),
        generatedBy: {
            userId: row.generatedByUserId,
            walletAddress: row.generatedByWallet,
            role: row.generatedByRole,
        },
        requestId: row.requestId,
        correlationId: row.correlationId,
        manifest: row.manifest,
    };
}
function createPostgresEvidenceBundleStore(pool) {
    const selectColumns = `SELECT
    bundle_id AS "bundleId",
    trade_id AS "tradeId",
    manifest_digest AS "manifestDigest",
    ricardian_hash AS "ricardianHash",
    generated_at AS "generatedAt",
    generated_by_user_id AS "generatedByUserId",
    generated_by_wallet AS "generatedByWallet",
    generated_by_role AS "generatedByRole",
    request_id AS "requestId",
    correlation_id AS "correlationId",
    manifest`;
    return {
        async save(record) {
            await pool.query(`INSERT INTO evidence_bundles (
          bundle_id,
          trade_id,
          manifest_digest,
          ricardian_hash,
          generated_at,
          generated_by_user_id,
          generated_by_wallet,
          generated_by_role,
          request_id,
          correlation_id,
          manifest
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
        )`, [
                record.bundleId,
                record.tradeId,
                record.manifestDigest,
                record.ricardianHash,
                record.generatedAt,
                record.generatedBy.userId,
                record.generatedBy.walletAddress,
                record.generatedBy.role,
                record.requestId,
                record.correlationId,
                JSON.stringify(record.manifest),
            ]);
            const stored = await this.get(record.bundleId);
            if (!stored) {
                throw new Error(`Failed to persist evidence bundle ${record.bundleId}`);
            }
            return stored;
        },
        async get(bundleId) {
            const result = await pool.query(`${selectColumns}
         FROM evidence_bundles
         WHERE bundle_id = $1`, [bundleId]);
            return result.rows[0] ? mapRow(result.rows[0]) : null;
        },
    };
}
function createInMemoryEvidenceBundleStore(initial = []) {
    const items = new Map(initial.map((record) => [record.bundleId, cloneManifest(record)]));
    return {
        async save(record) {
            items.set(record.bundleId, cloneManifest(record));
            return (await this.get(record.bundleId));
        },
        async get(bundleId) {
            const record = items.get(bundleId);
            return record ? cloneManifest(record) : null;
        },
    };
}
//# sourceMappingURL=evidenceBundleStore.js.map
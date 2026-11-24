'use strict';

// Signed reconciliation evidence (Cotsel#951).
//
// A completed reconciliation run is sealed by one signed manifest. The manifest
// lists the SHA-256 digest of every finding, the digest of the run's trade
// scope, and the run fields the treasury gate decides on (status, completion
// time, coverage). A finding is therefore verifiable on its own: recompute its
// digest and check that it is in a manifest whose signature verifies. Deleting,
// adding or altering any finding or scope row, or flipping coverage, breaks the
// match.
//
// The signer (reconciliation) and every verifier (treasury, the report CLI)
// read the evidence through readRunEvidence and canonicalize it here, so the
// two sides cannot disagree about what was signed.
const crypto = require('node:crypto');

const FINDING_SCHEMA = 'cotsel.reconciliation-finding.v1';
const MANIFEST_SCHEMA = 'cotsel.reconciliation-run-manifest.v1';

/** Canonical JSON: object keys sorted at every depth; no undefined or bigint. */
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Digest of one finding. Run-independent bookkeeping (run_id, occurrences,
 * timestamps) is excluded: the database maintains it, and the run is bound by
 * run_key, which is part of the digest.
 */
function findingDigest(finding) {
  return sha256Hex(
    canonicalJson({
      schema: FINDING_SCHEMA,
      runKey: finding.runKey,
      tradeId: finding.tradeId,
      severity: finding.severity,
      mismatchCode: finding.mismatchCode,
      comparedField: finding.comparedField,
      onchainValue: finding.onchainValue ?? null,
      indexedValue: finding.indexedValue ?? null,
      details: finding.details ?? {},
    }),
  );
}

function scopeDigest(tradeIds) {
  return sha256Hex(canonicalJson([...tradeIds].sort()));
}

/** Reads, through any query executor, exactly the evidence a manifest covers. */
async function readRunEvidence(db, runKey) {
  const run = await db.query(
    `SELECT run_key, status,
            to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS completed_at,
            coverage_from_block::text AS coverage_from_block,
            coverage_to_block::text AS coverage_to_block,
            coverage_complete,
            coverage_from_trade_id::text AS coverage_from_trade_id,
            coverage_to_trade_id::text AS coverage_to_trade_id
     FROM reconcile_runs WHERE run_key = $1`,
    [runKey],
  );
  const row = run.rows[0];
  if (!row) return null;
  const drifts = await db.query(
    `SELECT trade_id, severity, mismatch_code, compared_field, onchain_value, indexed_value, details
     FROM reconcile_drifts WHERE run_key = $1`,
    [runKey],
  );
  const scope = await db.query('SELECT trade_id FROM reconcile_run_trades WHERE run_key = $1', [
    runKey,
  ]);
  return {
    runKey: row.run_key,
    status: row.status,
    completedAt: row.completed_at,
    coverage: {
      fromBlock: row.coverage_from_block,
      toBlock: row.coverage_to_block,
      complete: row.coverage_complete,
      fromTradeId: row.coverage_from_trade_id,
      toTradeId: row.coverage_to_trade_id,
    },
    findings: drifts.rows.map((drift) => ({
      runKey: row.run_key,
      tradeId: drift.trade_id,
      severity: drift.severity,
      mismatchCode: drift.mismatch_code,
      comparedField: drift.compared_field,
      onchainValue: drift.onchain_value,
      indexedValue: drift.indexed_value,
      details: drift.details,
    })),
    scopeTradeIds: scope.rows.map((scopeRow) => scopeRow.trade_id),
  };
}

/**
 * The containment state a run asserts when it is sealed (review R01/R02/R03).
 * Read inside the sealing transaction, after the run's own containment writes.
 *
 * - containments: every open incident with its trade, reference, episode,
 *   state, opening and clearing run, and cited findings as (runKey, digest).
 * - clearances: the incidents THIS run cleared. Reconciliation records a
 *   clearance only for a trade it compared in this run and found clean, so a
 *   clearance is an explicit signed assertion, never an absence of findings.
 *
 * Verifiers never recompute this from live rows (containments change after
 * sealing); it is covered by the manifest signature alone.
 */
async function readContainmentSnapshot(db, runKey) {
  const rows = await db.query(
    `SELECT trade_id, incident_reference, episode, state, opened_run_key, cleared_run_key,
            to_char(opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS opened_at,
            qualifying_codes,
            cited_findings
     FROM reconcile_trade_containments
     WHERE state IN ('CONTAINED', 'RECONCILED_PENDING_APPROVAL')
     ORDER BY trade_id`,
  );
  const containments = rows.rows.map((row) => ({
    tradeId: row.trade_id,
    incidentReference: row.incident_reference,
    episode: row.episode,
    openedAt: `${row.opened_at}Z`,
    qualifyingCodes: row.qualifying_codes,
    state: row.state,
    openedRunKey: row.opened_run_key,
    clearedRunKey: row.cleared_run_key,
    citedFindings: [...row.cited_findings]
      .map((entry) => ({ runKey: entry.runKey, digest: entry.digest }))
      .sort((a, b) => (a.runKey + a.digest).localeCompare(b.runKey + b.digest)),
  }));
  const clearances = containments
    .filter(
      (entry) => entry.state === 'RECONCILED_PENDING_APPROVAL' && entry.clearedRunKey === runKey,
    )
    .map(({ tradeId, incidentReference, episode }) => ({ tradeId, incidentReference, episode }));
  return { containments, clearances };
}

/**
 * The manifest a run is sealed with. `sealed` carries what only the sealer
 * knows: the containment snapshot, its clearances and the chain context.
 */
function buildRunManifest(evidence, { keyId, rulesVersion, rulesDigest, sealed }) {
  return {
    ...(sealed
      ? {
          containments: sealed.containments,
          clearances: sealed.clearances,
          context: sealed.context,
        }
      : {}),
    schemaVersion: MANIFEST_SCHEMA,
    runKey: evidence.runKey,
    status: evidence.status,
    completedAt: evidence.completedAt,
    coverage: evidence.coverage,
    findings: {
      count: evidence.findings.length,
      digests: evidence.findings.map(findingDigest).sort(),
    },
    scope: { count: evidence.scopeTradeIds.length, digest: scopeDigest(evidence.scopeTradeIds) },
    rules: { version: rulesVersion, digest: rulesDigest },
    keyId,
  };
}

const manifestBytes = (manifest) => Buffer.from(canonicalJson(manifest), 'utf8');

/**
 * Accepted verification keys from JSON `{ "<keyId>": "<base64 SPKI DER>" }`.
 * Retired keys stay listed so the runs they signed remain verifiable.
 */
function parsePublicKeys(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Reconciliation finding public keys must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Reconciliation finding public keys must be a JSON object');
  }
  const keys = new Map();
  for (const [keyId, der] of Object.entries(parsed)) {
    if (!keyId || typeof der !== 'string') {
      throw new Error('Each reconciliation finding public key needs a key id and base64 DER');
    }
    const key = crypto.createPublicKey({
      key: Buffer.from(der, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error(`Reconciliation finding key ${keyId} must be an ECDSA P-256 public key`);
    }
    keys.set(keyId, key);
  }
  return keys;
}

const sameJson = (left, right) => canonicalJson(left) === canonicalJson(right);

/**
 * Everything needed to verify one run, as plain JSON: the run's evidence rows
 * and its seal. A bundle can be loaded here or received from reconciliation
 * over HTTP; verification is pure, so the transport needs no trust. A forged
 * bundle cannot carry a valid signature over rows it changed.
 */
async function loadRunEvidenceBundle(db, runKey) {
  const sealed = await db.query(
    'SELECT manifest, signature, key_id FROM reconcile_run_manifests WHERE run_key = $1',
    [runKey],
  );
  const seal = sealed.rows[0];
  return {
    runKey,
    seal: seal ? { manifest: seal.manifest, signature: seal.signature, keyId: seal.key_id } : null,
    evidence: await readRunEvidence(db, runKey),
  };
}

/** Pure: verifies a run bundle against its signed manifest. */
/**
 * `signatureOnly` checks the seal and manifest identity but not the run's
 * rows: for a manifest whose sealed fields alone are being relied on.
 */
function verifyRunEvidenceBundle(bundle, publicKeys, options = {}) {
  const seal = bundle?.seal;
  if (!seal) return { ok: false, reason: 'unsigned' };
  const manifest = seal.manifest;
  const key = publicKeys.get(seal.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  if (
    manifest?.schemaVersion !== MANIFEST_SCHEMA ||
    manifest.keyId !== seal.keyId ||
    manifest.runKey !== bundle.runKey ||
    typeof seal.signature !== 'string'
  ) {
    return { ok: false, reason: 'manifest_invalid' };
  }
  let signatureOk;
  try {
    signatureOk = crypto.verify(
      'sha256',
      manifestBytes(manifest),
      key,
      Buffer.from(seal.signature, 'base64'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };
  if (options.signatureOnly) return { ok: true, manifest };

  const evidence = bundle.evidence;
  if (!evidence || evidence.runKey !== bundle.runKey) return { ok: false, reason: 'run_mismatch' };
  let expected;
  try {
    expected = buildRunManifest(evidence, {
      keyId: manifest.keyId,
      rulesVersion: manifest.rules?.version,
      rulesDigest: manifest.rules?.digest,
    });
  } catch {
    return { ok: false, reason: 'run_mismatch' };
  }
  if (
    manifest.runKey !== expected.runKey ||
    manifest.status !== expected.status ||
    manifest.completedAt !== expected.completedAt ||
    !sameJson(manifest.coverage, expected.coverage)
  ) {
    return { ok: false, reason: 'run_mismatch' };
  }
  if (!sameJson(manifest.findings, expected.findings))
    return { ok: false, reason: 'findings_mismatch' };
  if (!sameJson(manifest.scope, expected.scope)) return { ok: false, reason: 'scope_mismatch' };
  return { ok: true, manifest };
}

/**
 * Verifies a run against its signed manifest. Returns `{ ok: true, manifest }`
 * or `{ ok: false, reason }`. `unsigned` means the run has no manifest at all
 * (it predates signing, or was never sealed); every other reason means the
 * evidence or its signature does not hold.
 */
async function verifyRunEvidence(db, runKey, publicKeys) {
  return verifyRunEvidenceBundle(await loadRunEvidenceBundle(db, runKey), publicKeys);
}

/**
 * Pure: per-finding status (Cotsel#951). `verified`: the signature holds and
 * the row's digest is listed. `failed`: the row is not covered by a valid
 * manifest (altered, injected, or the signature itself does not verify).
 * `missing`: the manifest lists a digest no row has, i.e. a deleted finding.
 * `unsigned`: the run has no manifest.
 */
function classifyRunEvidenceBundle(bundle, publicKeys) {
  const run = verifyRunEvidenceBundle(bundle, publicKeys);
  const evidence = bundle?.evidence;
  if (!evidence) return { run, findings: [] };
  const rows = evidence.findings.map((finding) => ({
    tradeId: finding.tradeId,
    mismatchCode: finding.mismatchCode,
    comparedField: finding.comparedField,
    digest: findingDigest(finding),
  }));
  if (run.ok === false && run.reason === 'unsigned') {
    return { run, findings: rows.map((row) => ({ ...row, status: 'unsigned' })) };
  }
  const listed = bundle.seal?.manifest?.findings?.digests;
  const signatureTrusted =
    run.ok || !['unknown_key', 'manifest_invalid', 'bad_signature'].includes(run.reason);
  if (!signatureTrusted || !Array.isArray(listed)) {
    return { run, findings: rows.map((row) => ({ ...row, status: 'failed' })) };
  }
  const listedSet = new Set(listed);
  const present = new Set(rows.map((row) => row.digest));
  return {
    run,
    findings: [
      ...rows.map((row) => ({ ...row, status: listedSet.has(row.digest) ? 'verified' : 'failed' })),
      ...listed
        .filter((digest) => !present.has(digest))
        .map((digest) => ({
          tradeId: null,
          mismatchCode: null,
          comparedField: null,
          digest,
          status: 'missing',
        })),
    ],
  };
}

/** Per-finding status for one run, loaded from the database. */
async function classifyRunFindings(db, runKey, publicKeys) {
  return classifyRunEvidenceBundle(await loadRunEvidenceBundle(db, runKey), publicKeys);
}

const CONTAINMENT_COLUMNS = `trade_id, incident_reference, state, opened_run_key,
  to_char(opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS opened_at, qualifying_codes,
  cleared_run_key, evidence`;

async function containmentBundle(db, row) {
  const { loadContainmentRecoveryBundle } = require('./containmentRecovery');
  return {
    recovery: await loadContainmentRecoveryBundle(db, row.trade_id),
    containment: {
      ...row,
      opened_at:
        row.opened_at instanceof Date
          ? row.opened_at.toISOString().replace('Z', '').padEnd(26, '0')
          : row.opened_at,
    },
    opening: await loadRunEvidenceBundle(db, row.opened_run_key),
    clearing: row.cleared_run_key ? await loadRunEvidenceBundle(db, row.cleared_run_key) : null,
  };
}

/** A containment with the run bundles its evidence rests on, or null. */
async function loadContainmentEvidenceBundle(db, tradeId) {
  const rows = await db.query(
    `SELECT ${CONTAINMENT_COLUMNS} FROM reconcile_trade_containments WHERE trade_id = $1`,
    [tradeId],
  );
  return rows.rows[0] ? containmentBundle(db, rows.rows[0]) : null;
}

function validateContainmentPageOptions({ limit = 50, cursor } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Invalid containment page limit');
  let after = null;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new RangeError('Invalid containment cursor');
    try {
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(after.openedAt) ||
        !Number.isFinite(Date.parse(after.openedAt)) ||
        !/^[0-9]{1,78}$/.test(after.tradeId)
      )
        throw new Error('shape');
    } catch {
      throw new RangeError('Invalid containment cursor');
    }
  }
  return { limit, after };
}

/** Stable keyset pages. Newly opened incidents appear on a list refresh. */
async function loadContainmentEvidencePage(db, options = {}) {
  const { limit, after } = validateContainmentPageOptions(options);
  const rows = await db.query(
    `SELECT ${CONTAINMENT_COLUMNS} FROM reconcile_trade_containments
     WHERE state <> 'RELEASED'
       AND ($1::timestamptz IS NULL OR (opened_at, trade_id) < ($1::timestamptz AT TIME ZONE 'UTC', $2::text))
     ORDER BY opened_at DESC, trade_id DESC LIMIT $3`,
    [after?.openedAt ?? null, after?.tradeId ?? null, limit + 1],
  );
  const selected = rows.rows.slice(0, limit);
  const items = [];
  for (const row of selected) items.push(await containmentBundle(db, row));
  const last = selected[selected.length - 1];
  const nextCursor =
    rows.rows.length > limit
      ? Buffer.from(
          JSON.stringify({
            openedAt: `${last.opened_at}Z`,
            tradeId: last.trade_id,
          }),
        ).toString('base64url')
      : null;
  return { items, nextCursor };
}

/** Every containment not yet released, newest first, at most `limit`. */
async function loadOpenContainmentEvidenceBundles(db, limit = 200) {
  const rows = await db.query(
    `SELECT ${CONTAINMENT_COLUMNS} FROM reconcile_trade_containments
     WHERE state <> 'RELEASED' ORDER BY opened_at DESC LIMIT $1`,
    [limit],
  );
  const bundles = [];
  for (const row of rows.rows) bundles.push(await containmentBundle(db, row));
  return bundles;
}

/**
 * Pure: a containment's evidence (Cotsel#951). `verified` only when the
 * opening run verifies, every finding the incident cites is a verified finding
 * of that run, and the clearing run (if any) verifies. `unsigned` when the
 * containment cites no digests (it predates signing) or the opening run has
 * no manifest.
 */
function verifyContainmentBundle(bundle, publicKeys, options = {}) {
  return require('./containmentSnapshot').verifyContainmentSnapshot(bundle, publicKeys, options);
}

/** A containment row's evidence, loaded from the database and verified. */
async function verifyContainmentEvidence(db, row, publicKeys) {
  return verifyContainmentBundle(await containmentBundle(db, row), publicKeys);
}

module.exports = {
  loadContainmentEvidencePage,
  validateContainmentPageOptions,
  classifyRunEvidenceBundle,
  readContainmentSnapshot,
  classifyRunFindings,
  loadContainmentEvidenceBundle,
  loadOpenContainmentEvidenceBundles,
  loadRunEvidenceBundle,
  verifyContainmentBundle,
  verifyContainmentEvidence,
  verifyRunEvidenceBundle,
  FINDING_SCHEMA,
  MANIFEST_SCHEMA,
  buildRunManifest,
  canonicalJson,
  findingDigest,
  manifestBytes,
  parsePublicKeys,
  readRunEvidence,
  scopeDigest,
  verifyRunEvidence,
};

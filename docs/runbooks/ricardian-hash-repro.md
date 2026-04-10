# Ricardian Hash Reproducibility Runbook

## Purpose

Provide deterministic, operator-safe reproduction of Ricardian hash outputs for legal-to-chain integrity checks.

## Canonical Source Of Truth

- Hash builder: `ricardian/src/utils/hash.ts` (`buildRicardianHash`)
- Canonicalization: `ricardian/src/utils/canonicalize.ts` (`canonicalJsonStringify`)
- Rules version: `ricardian/src/types.ts` (`CANONICALIZATION_RULES_VERSION`)

The hash preimage is:

- `RICARDIAN_CANONICAL_V1:<canonicalJson>`

Where `canonicalJson` is built from this payload shape with sorted keys and `undefined` keys omitted:

- `{ "documentRef": <string>, "metadata": <object>, "terms": <object> }`

## Required Inputs

- `documentRef` (string, non-empty)
- `terms` (object)
- `metadata` (object, optional; defaults to `{}`)

`requestId` is accepted by the API but is not part of the hash preimage.

## Deterministic Reproduction Command

Prepare payload JSON:

```json
{
  "documentRef": "doc://trade-2026-0001",
  "metadata": {
    "tradeId": "1",
    "jurisdiction": "KE"
  },
  "terms": {
    "currency": "USDC",
    "incoterm": "FOB",
    "quantityMt": 100
  }
}
```

Run:

```bash
node scripts/reproduce-ricardian-hash.mjs --payload-file /tmp/ricardian-payload.json --pretty
```

Expected output format:

```json
{
  "documentRef": "doc://trade-2026-0001",
  "rulesVersion": "RICARDIAN_CANONICAL_V1",
  "canonicalJson": "{\"documentRef\":\"doc://trade-2026-0001\",\"metadata\":{\"jurisdiction\":\"KE\",\"tradeId\":\"1\"},\"terms\":{\"currency\":\"USDC\",\"incoterm\":\"FOB\",\"quantityMt\":100}}",
  "preimage": "RICARDIAN_CANONICAL_V1:{...canonicalJson...}",
  "hash": "<64-char lowercase hex>",
  "metadata": {
    "tradeId": "1",
    "jurisdiction": "KE"
  }
}
```

## API Contract (Required Payload + Output Format)

- Create hash:
  - `POST /api/ricardian/v1/hash`
  - Request payload fields:
    - `requestId?`, `documentRef`, `terms`, `metadata?`
  - Success response includes:
    - `id`, `requestId`, `documentRef`, `hash`, `rulesVersion`, `canonicalJson`, `metadata`, `createdAt`
- Fetch hash:
  - `GET /api/ricardian/v1/hash/:hash`
  - Returns the same typed record shape.

Controller behavior source: `ricardian/src/api/controller.ts`.

## SDK Helper Contract

- `sdk/src/modules/ricardianClient.ts`
  - `generateHash(payload)` expects `RicardianHashRequest`.
  - `getHash(hash)` returns `RicardianHashRecord`.
- Types are defined in `sdk/src/types/ricardian.ts`.

## Storage/Retrieval Path And Failure Handling

- Write path:
  - `ricardian/src/database/documentStore.ts#createDocument`
    - Wraps `ricardian/src/database/queries.ts#createRicardianHash` with retry and typed errors.
  - Persists into `ricardian_hashes` with uniqueness on `(hash, document_ref)`.
  - Conflict behavior: update `metadata` and return row.
- Read path:
  - `ricardian/src/database/documentStore.ts#getDocument`
    - Wraps `ricardian/src/database/queries.ts#getRicardianHash` with retry, not-found handling, and integrity verification.
  - Lookup by `hash`, latest row first.
  - Every successful read verifies SHA-256 integrity: `sha256(rulesVersion + ":" + canonicalJson)` must equal the stored hash.
- Retry boundaries (hardened defaults, module constants):
  - `MAX_RETRIES = 3` (4 total attempts)
  - `BASE_DELAY_MS = 100` (truncated exponential back-off: 100 → 200 → 400 ms)
  - Transient errors: connection loss, timeout, ETIMEDOUT, ECONNREFUSED, serialization failure, pg codes 40001/40P01/08001/08004/08006/53300/57P03
- API failure mapping:
  - `400`: invalid payload or invalid hash format
  - `404`: hash not found (`DOCUMENT_NOT_FOUND`)
  - `500`: persistence failure (`DOCUMENT_PERSISTENCE_FAILURE`), retrieval failure (`DOCUMENT_RETRIEVAL_FAILURE`), or integrity violation (`DOCUMENT_INTEGRITY_FAILURE`)

## Document Store Durability Contract

- Writes are idempotent: the same `(hash, documentRef)` pair never produces duplicate rows.
- `documentRef` is immutably tied to `ricardianHash` after the first write; subsequent writes for the same pair may update `metadata` only.
- All writes and reads are retried on transient faults before surfacing a typed error to the caller.
- The document store does not store the original PDF or contract file; it anchors the SHA-256 hash of the off-chain canonical payload.

## Backup/Restore And Legal-Evidence Retrieval

Ricardian hash records are stored in the `ricardian_hashes` Postgres table. Backup and restore are covered by the shared Postgres recovery runbook and smoke test:

- Runbook: `docs/runbooks/postgres-backup-restore-recovery.md`
- Smoke test script: `scripts/postgres-backup-restore-smoke.sh`
- Recovery evidence artifacts: `reports/postgres-recovery/`

For legal/audit retrieval scenarios (e.g. dispute review or regulatory inquiry), the complete integrity chain is:

1. Retrieve the row via `GET /api/ricardian/v1/hash/:hash`.
2. Run the integrity verification procedure above to confirm the stored `hash` matches the `canonicalJson` and `rulesVersion`.
3. Run `scripts/reproduce-ricardian-hash.mjs` with the original payload to confirm the `canonicalJson` and `hash` match the original inputs.
4. Cross-reference against the on-chain `ricardianHash` emitted at escrow lock (contract event).

## Operator Failure Triage

1. Reproduce hash locally with `scripts/reproduce-ricardian-hash.mjs`.
2. Compare reproduced `canonicalJson` and `hash` with API response row.
3. If mismatch:
   - Verify payload field ordering/undefined handling assumptions.
   - Check `rulesVersion` consistency.
   - Check reconciliation findings for `HASH_MISMATCH`.
4. If API returns `500` with `code: DOCUMENT_RETRIEVAL_FAILURE`:
   - Check Postgres availability and connection pool health.
   - Inspect ricardian service logs for retry exhaustion: look for `DocumentStore transient error, retrying` entries.
   - If retries were exhausted (4 attempts), the Postgres connection pool was likely degraded — check DB host/port and connection limits.
5. If API returns `500` with `code: DOCUMENT_INTEGRITY_FAILURE`:
   - **Escalate immediately.** This indicates the stored row does not match its own SHA-256 hash.
   - Capture the full row from the `ricardian_hashes` table.
   - Run the integrity verification procedure (see above) to confirm.
   - Preserve all evidence before any row modification.
6. If API returns `500` with `code: DOCUMENT_PERSISTENCE_FAILURE`:
   - Check Postgres write availability.
   - Reproduce the hash locally to confirm the payload was valid before retrying.
7. If API returns `500` with no `code` field, capture service logs and DB availability evidence, then escalate.

## Escalation Guidance

- Escalate immediately when:
  - `code: DOCUMENT_INTEGRITY_FAILURE` is returned, storage tamper or corruption
  - same input set produces different hash across environments
  - repeated `HASH_MISMATCH` findings appear in reconciliation
  - Ricardian persistence/read path returns sustained `500`
- Include:
  - payload JSON
  - reproduced output (`canonicalJson`, `hash`, `rulesVersion`)
  - API request/response pair (including `code` field)
  - relevant ricardian + reconciliation logs
  - raw DB row from `ricardian_hashes` (if `DOCUMENT_INTEGRITY_FAILURE`)

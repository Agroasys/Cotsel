# Legal Evidence Package Template

## Purpose
Provide a deterministic, audit-ready evidence pack format that proves:
- off-chain Ricardian document identity (`documentRef`)
- deterministic hash derivation
- on-chain trade anchoring (`ricardianHash`)
- indexed and reconciled operational evidence

Use this template for enforceability consultations, pilot sign-off, and legal review requests.

## When To Use
- At pilot window close for legal/compliance handoff.
- Before governance sign-off for production-readiness evidence.
- During dispute or audit requests that require proof of document-to-chain linkage.

## Scope
- Ricardian PDF/hash reproducibility evidence.
- Trade-level chain/indexer/reconciliation linkage.
- Versioned handoff packet structure and reproducibility checklist.

## Non-Scope
- Legal interpretation of contract terms.
- Court filing process by jurisdiction.
- Storage of raw private keys or secret material.

## Required Inputs

| Input | Description | Source |
|---|---|---|
| `tradeId` | Trade identifier used by escrow/indexer/reconciliation | Escrow + indexer |
| `documentRef` | Off-chain Ricardian document reference | Ricardian payload |
| `ricardianHash` | Canonical hash for the legal agreement | Ricardian API + on-chain/indexer |
| `rulesVersion` | Canonicalization/version marker | Ricardian response |
| `txHash` / `extrinsicHash` | Settlement transaction identifiers | Oracle/indexer/chain explorer |
| `runKey` | Reconciliation run identifier for evidence window | Reconciliation |
| `from` / `to` UTC | Evidence window boundaries | Pilot owner/operator |
| `chainId` + network name | Chain context for verifier | Environment config |
| Evidence owner/sign-off | Responsible operator and reviewer | Ops/legal |

## Deterministic Hash Recipe and Verification Steps

Reference runbook: `docs/runbooks/ricardian-hash-repro.md`.

### Step 1: Reproduce Hash Locally From Canonical Payload
Prepare a payload JSON with:
- `documentRef`
- `terms`
- `metadata` (optional)

Run:

```bash
node scripts/reproduce-ricardian-hash.mjs --payload-file /tmp/ricardian-payload.json --pretty
```

Record:
- `rulesVersion`
- `canonicalJson`
- `preimage`
- `hash`

### Step 2: Verify Hash Record in Ricardian API

```bash
curl -fsS "http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/hash/<hash>"
```

Confirm:
- `hash` matches Step 1 output
- `documentRef` matches legal document reference
- `rulesVersion` matches expected canonicalization version

### Step 3: Verify Trade-Level Indexed Linkage

```bash
curl -fsS "${INDEXER_GRAPHQL_URL}" \
  -H 'content-type: application/json' \
  --data '{"query":"query($tradeId:String!){trades(where:{tradeId_eq:$tradeId}){tradeId ricardianHash status createdAt}}","variables":{"tradeId":"<tradeId>"}}'
```

Confirm:
- `tradeId` exists
- indexed `ricardianHash` equals Step 1/Step 2 hash

### Step 4: Verify Chain Reference
- Capture chain explorer URL(s) for each relevant `txHash`/`extrinsicHash`.
- Confirm explorer details match expected trade lifecycle events for the same trade.

### Step 5: Verify Reconciliation Linkage
- Run or retrieve reconciliation evidence for the same time window/run key.
- Confirm any drift status is documented and consistent with pilot sign-off criteria.

## Trade-Level Proof Template

Populate one row per trade in scope.

| Trade ID | Document Ref | Reproduced Hash | API Hash | Indexed Hash | Chain Tx/Extrinsic | Explorer URL | Reconciliation Run Key | Reconciliation Result | Verifier Initials | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `<tradeId>` | `<documentRef>` | `<0x/hex>` | `<0x/hex>` | `<0x/hex>` | `<txHash/extrinsicHash>` | `<url>` | `<runKey>` | `PASS / FAIL` | `<initials>` | `<notes>` |

Validation rule:
- `Reproduced Hash == API Hash == Indexed Hash` for a PASS linkage result.

## Versioned Legal Handoff Packet Format

Use a deterministic packet folder with explicit versioning:

```
legal-evidence/
  <pilot-window-id>/
    LEGAL_EVIDENCE_PACKET_V1/
      01-cover-sheet.md
      02-proof-table.csv
      03-hash-reproduction/
        payload-<tradeId>.json
        reproduced-<tradeId>.json
      04-chain-evidence/
        explorer-links.md
        tx-snapshots/
      05-indexer-evidence/
        trades-query.json
        trade-events-query.json
      06-reconciliation-evidence/
        reconcile-run-summary.json
        reconcile-drifts.json
      07-redaction-log.md
      08-signoff.md
```

Required packet metadata (include in `01-cover-sheet.md`):
- `packetVersion`: `LEGAL_EVIDENCE_PACKET_V1`
- `generatedAt` (UTC)
- `environment`
- `chainId`
- `from` / `to` window
- `preparedBy`
- `reviewedBy`

## Reproducibility Checklist

- [ ] `documentRef` and payload source captured for each trade.
- [ ] Hash reproduced with `scripts/reproduce-ricardian-hash.mjs`.
- [ ] API hash record fetched and archived.
- [ ] Indexer trade query archived and hash equality validated.
- [ ] Explorer URLs captured for all referenced transactions.
- [ ] Reconciliation run summary and drifts archived.
- [ ] All timestamps recorded in UTC.
- [ ] Packet version and sign-off fields completed.

## Evidence Retention and Redaction Guidance

- Store evidence in immutable storage with retention aligned to legal/compliance policy.
- Never include private keys, raw auth tokens, or secret environment values.
- Redact personal data and non-essential commercial terms unless required for review scope.
- Keep a `07-redaction-log.md` documenting:
  - what was redacted
  - why it was redacted
  - who approved the redaction
- Preserve original file hashes for any redacted document derivatives.

## Related Runbooks
- `docs/runbooks/ricardian-hash-repro.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/pilot-kpi-report-template.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/production-readiness-checklist.md`

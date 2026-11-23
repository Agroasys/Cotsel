# Signed reconciliation findings

Audience: reconciliation and treasury operators, and security reviewers. Scope: #951, migration `202611230002_run_manifests` and `@agroasys/shared-db/reconciliationEvidence`.

## What is signed

When a reconciliation run completes, it is sealed by one signed **run manifest**, stored in `reconcile_run_manifests`. The manifest contains:

- the SHA-256 digest of every finding, listed individually;
- the count and digest of the run's trade scope;
- the run's status, completion time and coverage fields;
- the risk-rules version and digest;
- the signing key id.

Each finding's digest covers its run key, trade, severity, mismatch code, compared field, both values and its details. A single finding is verifiable on its own: recompute its digest, then check that it is listed in a manifest whose signature verifies.

**Signature scheme:** ECDSA P-256 with SHA-256. In staging and production the key is the foundation KMS key `reconciliation_finding_key_arn`. It is used for nothing else, and only the reconciliation task role may sign with it, only over digests.

**Where sealing happens:** inside the transaction that completes the run, after the run row is completed and before COMMIT. The manifest is built from the rows as written, so it also covers evidence a finishing enumeration cycle copies in from earlier runs.

**Database protections:**

- After a run is completed, the published-evidence triggers (migration 006) freeze it.
- Manifests can be inserted only into the transaction completing their run, and can never be updated or deleted.

## Who verifies

Every reader verifies with the same shared code and the same reader of the database rows.

| Reader                                                                                 | What it does on failure                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treasury reconciliation gate: per-trade decisions and the empty-export snapshot anchor | **Blocks** the whole run: `reconciliation_evidence_invalid`, or `reconciliation_evidence_unsigned` when the run has no manifest. Logs `RECONCILIATION_EVIDENCE_INVALID` or `RECONCILIATION_EVIDENCE_UNSIGNED`.                                                                                                                                                                                                                |
| Report CLI (`report-cli.ts`)                                                           | Adds `evidence.status` for the run (`verified`, `failed` with the reason, `unsigned`, or `unverifiable` when no keys are configured) and `evidence.findings[]` with each finding's digest and status: `verified`; `failed` (altered or injected, or the signature does not verify); `missing` (listed in the manifest but no row has it, i.e. deleted, so an altered row also shows its original digest here); or `unsigned`. |
| Containment evidence and the `RECONCILIATION_TRADE_CONTAINED` alert                    | Carry the digests of the findings that opened the containment, plus the rules version and digest. The governance freeze request therefore cites findings an approver can check against the signed manifest.                                                                                                                                                                                                                   |

**What verification catches:**

- a finding that is altered, deleted or added;
- a scope row added for a trade the run never compared;
- a flipped coverage flag;
- a moved completion time;
- a rewritten manifest, or one signed by an unknown key.

Tests: `reconciliation/src/tests/signed-findings.postgres.test.ts` tampers past the database triggers, as a database owner could. `treasury/tests/reconciliationReader.postgres.test.ts` shows that an injected scope row blocks the trade.

The gateway does not read findings today. Cotsel.dash#228 shows verification state, and #957 distributes findings with their manifest.

## Configuration

| Setting                                  | Service                                                       | Meaning                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECONCILIATION_FINDING_SIGNER`          | reconciliation                                                | `kms:<key ARN>` in staging and production; `local:<label>` only with `COTSEL_ENVIRONMENT=local`. The part after the first colon is the manifest key id. Unset: the daemon refuses to start. |
| `RECONCILIATION_FINDING_SIGNING_KEY`     | reconciliation (local only)                                   | A base64 PKCS#8 P-256 private key.                                                                                                                                                          |
| `RECONCILIATION_FINDING_SIGN_TIMEOUT_MS` | reconciliation                                                | Default `5000`. At most a quarter of the lease TTL, because signing runs under the run's lease.                                                                                             |
| `RECONCILIATION_FINDING_PUBLIC_KEYS`     | treasury (required with `RECONCILIATION_DB_NAME`), report CLI | JSON of the form `{"<key id>": "<base64 SPKI DER>"}`. For staging, use the foundation outputs `reconciliation_finding_key_arn` and `reconciliation_finding_public_key`.                     |

## Deploy order and rollback

1. Apply the foundation stack (it creates the key and grant), then the platform stack.
2. Deploy reconciliation. Every run completed from then on is sealed.
3. Deploy treasury with `RECONCILIATION_FINDING_PUBLIC_KEYS`. Until a signed run completes, the latest run is unsigned and exports are blocked with `reconciliation_evidence_unsigned`. That lasts one daemon interval.

**During the cutover:**

- An export whose build started against an unsigned run fails its publication re-check, and is retried against the next run, which is signed.
- Completed exports are served from their stored context and are never re-assessed, so runs that predate signing do not affect them.
- `RECONCILIATION_EVIDENCE_UNSIGNED` is logged once per gate read until that signed run completes.

**Cost:** at 100,000 scope rows and 100 findings, sealing took about 32 ms and verification about 25 ms per read (PostgreSQL 16, local).

**Order of applies:** the platform stack reads the foundation outputs `reconciliation_finding_key_arn`, so the foundation must be applied first.

**Rollback:** reverting reconciliation stops sealing, and a treasury still verifying then blocks exports. Revert treasury first, then reconciliation. Manifests already written stay valid, and migration 009 is additive.

## Response

**`reconciliation_findings_signing_failed`** (KMS refused or timed out):

- The run is not completed: its findings are not published, and the cursor holds. Nothing is ever published unsigned.
- Restore the task role's access to the key, and check the KMS key state.
- The next run reconciles the window again.

**`treasury_reconciliation_evidence_invalid`:**

- A run's rows no longer match their signed manifest. Treat this as tampering.
- Open an incident and preserve the reconciliation database. Do not repair rows.
- Re-run reconciliation for the window, which produces a new signed run.

**`treasury_reconciliation_evidence_unsigned`:**

- Expected briefly after the first deploy.
- Otherwise, confirm reconciliation is running with a signer, and check `reconciliation_findings_signing_failed`.

## Key rotation

1. Create the new key and add its public key to `RECONCILIATION_FINDING_PUBLIC_KEYS` **before** switching the signer.
2. Switch `RECONCILIATION_FINDING_SIGNER` to `kms:<new key ARN>`.
3. Keep the old key's entry, and the key itself (`prevent_destroy`), so earlier runs stay verifiable.

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

**Signature scheme:** ECDSA P-256 with SHA-256. In staging and production the key is the foundation KMS key `reconciliation_finding_key_arn`. Only the reconciliation task role may sign with it, over digests. The same evidence key signs nonce-bound action replies under a separate schema domain.

**Where sealing happens:** inside the transaction that completes the run, after the run row is completed and before COMMIT. The manifest is built from the rows as written, so it also covers evidence a finishing enumeration cycle copies in from earlier runs.

**Database protections:**

- After a run is completed, the published-evidence triggers (migration 006) freeze it.
- Manifests can be inserted only into the transaction completing their run, and can never be updated or deleted.

## Who verifies

Server readers verify with the shared verifier. Dash independently verifies the raw proof with WebCrypto and a configured public-key ring; it does not trust the gateway verdict.

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

## Governance acts only on verified evidence

Each completed run signs its chain and escrow context, current containment snapshot, episode, finding lineage and exact-trade clean clearances. The verifier resolves every cited digest against its own signed run. Repeated divergence keeps the incident and adds that run's findings; a later clean run must cover that same trade and episode.

For a trade-scoped unpause, the gateway verifies a fresh signed snapshot against its own chain and escrow:

- A reconciliation incident must be `RECONCILED_PENDING_APPROVAL`. Its clearing run must be newer than every cited divergence, cover that exact trade, cite that incident and episode, and contain no qualifying discrepancy for it.
- A non-reconciliation pause may use normal quorum approval only when a fresh signed snapshot confirms no open reconciliation incident for the trade. A missing row, endpoint error or unverifiable reply alone is not evidence of absence.
- The default snapshot age limit is 900 seconds. A future timestamp beyond 60 seconds, stale proof, unavailable endpoint, unknown rules or key, and any binding mismatch block preparation.
- The gateway checks again immediately before returning the signing payload. A confirmation records another assessment against the stored preparation. External wallets can still broadcast previously obtained calldata; the confirmation assessment cannot prevent an already broadcast transaction. The escrow quorum remains the on-chain authority.
- `containment-cli release` uses the same recovery decision before it reads the chain. Reconciliation never unpauses or freezes automatically.

The internal evidence transport uses port 9090. It returns raw bundles in one repeatable-read snapshot. Keep it off the ALB and restrict ingress to the existing gateway security group. The gateway verifies with its own keys and never holds reconciliation database credentials.

### Current action response authentication

Each gateway action lookup generates a random 256-bit challenge. This applies to recovery, freeze review, freeze preparation and handoff revalidation.

Reconciliation loads the response from its database snapshot. It signs these fields with the configured evidence signer:

- schema domain `cotsel.reconciliation-action-response.v1`;
- gateway challenge and requested resource;
- chain and escrow context;
- exact response digest and latest manifest digest;
- issuance time.

The gateway checks the signature with its own trusted key ring. It also checks every binding and digest before evaluating recovery.

Replies expire after 30 seconds. Replies over five seconds in the future fail. Missing, malformed or replayed attestations fail closed.

This prevents replay of a pre-request signed snapshot as the current service response. Historical display proofs do not need this action challenge.

Action lookups require KMS availability in deployed KMS mode. Each lookup adds one signature operation. Deploy the attesting reconciliation image before its gateway consumer.

### Recorded freeze approval

Migration 011 records an immutable `reconcile_governance_freeze_requests` row in the same transaction as the signed opening run. Its content hash binds the exact trade, incident, episode, context, rules and signed finding references. An alert is not an approval.

An operator uses the gateway under `/api/dashboard-gateway/v1`:

1. Read `GET /governance/freeze-requests/{requestId}`. Inspect the signed incident and its evidence. A read reports the request, recorded review and most recent associated governance action separately.
2. Send `POST .../{requestId}/review` with `decision` (`approved` or `rejected`) and the standard governance `audit` object. The gateway records the actor, reason, ticket and step-up in one transaction with the review. The recorded decision is immutable.
3. For an approved request, send `POST .../{requestId}/prepare` with the registered `signerWallet` and `audit`. The gateway re-verifies the request and prepares the exact existing `pauseTrade(tradeId)` call. Human approval does not broadcast it.
4. Review and sign through the existing hardware-wallet procedure. Report the transaction through `POST /governance/actions/{actionId}/confirm`. A reported hash remains pending verification until the existing chain verifier observes it. Inspect the read endpoint for the actual execution state.

All review and prepare requests require mutation access, `governance:write`, fresh hardware step-up and an idempotency key. A rejected request cannot prepare a pause. Reconciliation has no governance signing identity.

### Display and pagination

`GET /reconciliation/containments` accepts `limit` (1–200, default 50) and an opaque `cursor`. It returns `items` and `nextCursor`. Continue until the cursor is null. The keyset is open time and trade id; it is not a snapshot across HTTP pages. Concurrent new incidents can appear on a later refresh. Never treat an unfinished or failed page sequence as a complete inventory.

Each item carries its raw `proof`. Dash verifies the P-256 signature, finding membership, scope, incident binding, rules and clearing evidence itself using `VITE_RECONCILIATION_FINDING_PUBLIC_KEYS`. This variable contains public SPKI keys only. Supply trusted keys in the build configuration before deployment; never copy a trust key from the evidence response. Keep historical verification keys during rotation. Display authenticity does not imply current action freshness; the gateway checks the action clock.

## Configuration

| Setting                                           | Service                                                                                                                                                      | Meaning                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECONCILIATION_FINDING_SIGNER`                   | reconciliation                                                                                                                                               | `kms:<key ARN>` in staging and production; `local:<label>` only with `COTSEL_ENVIRONMENT=local`. The part after the first colon is the manifest key id. Unset: the daemon refuses to start. |
| `RECONCILIATION_FINDING_SIGNING_KEY`              | reconciliation (local only)                                                                                                                                  | A base64 PKCS#8 P-256 private key.                                                                                                                                                          |
| `RECONCILIATION_FINDING_SIGN_TIMEOUT_MS`          | reconciliation                                                                                                                                               | Default `5000`. At most a quarter of the lease TTL, because signing runs under the run's lease.                                                                                             |
| `GATEWAY_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS` | gateway                                                                                                                                                      | Maximum age of the signed snapshot used for actions. Default `900`; accepted range `60..86400`.                                                                                             |
| `RECONCILIATION_FINDING_PUBLIC_KEYS`              | treasury (required with `RECONCILIATION_DB_NAME`), gateway (trade-unpause guard and containment API), reconciliation (`containment-cli release`), report CLI | JSON of the form `{"<key id>": "<base64 SPKI DER>"}`. For staging, use the foundation outputs `reconciliation_finding_key_arn` and `reconciliation_finding_public_key`.                     |

## Deploy order and recovery

1. Apply the foundation stack (it creates the key and grant), then the platform stack.
2. Deploy reconciliation. Every run completed from then on is sealed.
3. Deploy treasury with `RECONCILIATION_FINDING_PUBLIC_KEYS`. Until a signed run completes, the latest run is unsigned and exports are blocked with `reconciliation_evidence_unsigned`. That lasts one daemon interval.
4. Deploy the gateway with `RECONCILIATION_FINDING_PUBLIC_KEYS`, after the reconciliation image that serves `/containments`. If the gateway runs first, the containment API and trade-unpause approvals fail closed with 503 `reconciliation_evidence_unavailable` (`endpoint_missing`) until reconciliation is deployed.

**During the cutover:**

- An export whose build started against an unsigned run fails its publication re-check, and is retried against the next run, which is signed.
- Completed exports are served from their stored context and are never re-assessed, so runs that predate signing do not affect them.
- `RECONCILIATION_EVIDENCE_UNSIGNED` is logged once per gate read until that signed run completes.

**Cost:** at 100,000 scope rows and 100 findings, sealing took about 32 ms and verification about 25 ms per read (PostgreSQL 16, local).

**Order of applies:** the platform stack reads the foundation outputs `reconciliation_finding_key_arn`, so the foundation must be applied first.

**Recovery:** an earlier image whose manifest lacks applied migrations cannot start. Nullable columns do not change that startup contract. Do not edit the ledger, remove applied migrations, disable signatures, or downgrade treasury to unsigned trust. Stop new settlement ingress and privileged mutations while investigating. Keep signed reconciliation and treasury verification running. Repair forward with the current immutable migration manifest and reviewed application changes. A compatibility image must retain every applied migration and verification boundary and must be rehearsed before it is an approved recovery option. No such deployed-image rehearsal is claimed by local database checks. See [M6 continuation acceptance](m6-continuation-acceptance.md).

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

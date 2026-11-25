# Signed reconciliation findings

Use this runbook to deploy signed reconciliation evidence and respond to verification failures. It is for reconciliation operators, treasury operators and security reviewers.

Issue #951 covers the `@agroasys/shared-db/reconciliationEvidence` verifier. The reconciliation manifest names migration version `202611230002` as `run_manifests` and points to `009_run_manifests.sql`.

## Run manifests

Reconciliation seals each completed run with one signed run manifest in `reconcile_run_manifests`. The manifest records these fields:

- the SHA-256 digest of each finding, listed separately
- the count and digest of the trade scope for the run
- the run status, completion time and coverage fields
- the risk-rules version and digest
- the signing key ID

A finding digest covers its schema, run key, trade, severity, mismatch code, compared field, both values and the finding details. The digest excludes bookkeeping fields such as `run_id`, `occurrences` and row timestamps. To verify one finding, use this sequence:

1. Recompute the finding digest.
2. Verify the manifest signature.
3. Check that the manifest lists the recomputed digest.

Reconciliation uses the Elliptic Curve Digital Signature Algorithm (ECDSA) with the P-256 curve and SHA-256. Staging and production configuration requires the foundation AWS Key Management Service (KMS) key `reconciliation_finding_key_arn`. Among runtime task roles, only reconciliation has permission to sign digests with that key. The same key signs challenge-bound action replies under a separate schema domain.

Reconciliation completes the run row before it seals the manifest, all in one transaction before `COMMIT`. It builds the manifest from the stored rows. This includes evidence that a finishing enumeration cycle copies from earlier runs.

The published-evidence triggers in migration 006 freeze completed runs. The database permits a manifest insert only in the transaction that completes the run. It rejects every update or deletion of a manifest.

## Verify evidence

Server readers use the shared verifier. Dash verifies the raw proof independently with WebCrypto and its configured public keys. The gateway verdict cannot substitute for browser verification.

### Treasury gate

The treasury reconciliation gate verifies per-trade decisions and the snapshot anchor for empty exports. If verification fails, it blocks the whole run with `reconciliation_evidence_invalid` and logs `RECONCILIATION_EVIDENCE_INVALID`. If the run has no manifest, the gate returns `reconciliation_evidence_unsigned` and logs `RECONCILIATION_EVIDENCE_UNSIGNED`.

### Report output

The report command-line interface (CLI), `report-cli.ts`, sets `evidence.status` for the run. The run statuses are:

- `verified` when verification succeeds
- `failed` with the reason when verification fails
- `unsigned` when the run has no manifest
- `unverifiable` when the verifier has no configured keys

The report includes the digest and status of each finding in `evidence.findings[]`. The finding statuses are:

- `verified` when verification succeeds
- `failed` when a finding changed, an added finding has no match, or the signature fails verification
- `missing` when the manifest lists a digest that no stored row matches
- `unsigned` when the run has no manifest
- `unverifiable` when the verifier has no configured keys

A changed finding also leaves its original digest `missing`.

### Containment evidence

Containment evidence and the `RECONCILIATION_TRADE_CONTAINED` alert contain the digests of the findings that opened the containment. They include the rules version and digest. The governance freeze request cites findings that an approver can verify against the signed manifest. The risk rules qualify findings for containment by mismatch code. The `occurrences` counter does not determine containment.

### Changes that verification detects

Verification detects these changes:

- an altered signed finding field, a deleted finding or an added finding
- an added scope row for a trade that the run never compared
- a changed coverage flag
- a changed completion time
- a rewritten manifest or a signature from an unknown key

The test `reconciliation/src/tests/signed-findings.postgres.test.ts` changes evidence beyond the triggers, as a database owner could. The test `treasury/tests/reconciliationReader.postgres.test.ts` verifies that an added scope row blocks the trade.

## Governance recovery and freeze controls

Each completed run signs its chain and escrow context, containment snapshot, incident episode, finding lineage and exact-trade clean clearances. Finding lineage identifies the runs that produced the cited findings. The verifier resolves each cited digest against the signature of its own run. Repeated divergence keeps the incident open and adds the new run's findings. A later clean run must cover the same trade and episode.

A finishing enumeration cycle retains its earlier findings. If it retains a qualifying finding for the trade, that run cannot clear the incident. A subsequent clean comparison can clear the same episode when its signed evidence has no qualifying finding for that trade. The earlier signed findings stay in the incident history.

Before it prepares a trade-scoped unpause, the gateway checks a fresh signed snapshot against its own chain and escrow. These conditions control the decision:

- A reconciliation incident must be `RECONCILED_PENDING_APPROVAL`. The clearing run must be newer than every cited divergence. It must cover the exact trade and cite the same incident and episode. It must contain no qualifying discrepancy for that trade.
- A non-reconciliation pause can use normal quorum approval only if a fresh signed snapshot confirms no open reconciliation incident for the trade. A missing row, an endpoint error or an unverifiable reply cannot establish absence.
- The snapshot age limit defaults to 900 seconds. Preparation fails if the snapshot timestamp is more than 60 seconds in the future or if the proof is stale. An unavailable endpoint, unknown rules, an unknown key or a binding mismatch also blocks preparation.

The proof applies to the snapshot time. A newer run can complete after that snapshot. The gateway rechecks the evidence immediately before it returns the signing payload. Confirmation records another assessment against the stored preparation. External wallets can still broadcast previously obtained calldata. The confirmation assessment cannot prevent a transaction that an external wallet already broadcast. The escrow quorum remains the on-chain authority.

`containment-cli release` uses the same recovery decision before it reads the chain. Reconciliation never unpauses or freezes automatically.

The internal evidence endpoint uses port 9090. It returns the raw bundles from one repeatable-read snapshot. Keep it off the Application Load Balancer (ALB). Limit ingress to the existing gateway security group. The gateway verifies replies with its own keys and never holds reconciliation database credentials.

### Authenticate current action replies

The gateway generates a random 256-bit challenge for each action lookup. This applies to recovery, freeze review, freeze preparation and handoff revalidation.

Reconciliation loads the reply from its database snapshot. The configured evidence signer signs these fields:

- the schema domain `cotsel.reconciliation-action-response.v1`
- the gateway challenge and the requested resource
- the chain and escrow context
- the exact reply digest and the latest manifest digest
- the issuance time

The gateway checks the signature with its own trusted public keys. It checks each binding and digest before it evaluates recovery.

A reply expires after 30 seconds. The gateway refuses replies with issuance times more than five seconds in the future. A missing, malformed or replayed attestation blocks the action.

The challenge prevents replay of a signed snapshot from before the request as the current reply. Historical display proofs do not need a challenge.

In deployed KMS mode, each action lookup requires KMS and adds one signature operation. Deploy the reconciliation image that signs action replies before the gateway that verifies them.

### Review and execute a freeze request

Migration 011 stores an immutable `reconcile_governance_freeze_requests` row in the same transaction as the signed opening run. The content hash binds the exact trade, incident, episode, context, rules and signed finding references. The alert only reports containment. Approval requires a recorded human decision.

Review and preparation require mutation access, `governance:write`, fresh hardware step-up authentication and an idempotency key. A rejected request cannot prepare a pause. Reconciliation has no governance signing identity.

Use the gateway application programming interface (API) under `/api/dashboard-gateway/v1`:

1. Send `GET /governance/freeze-requests/{requestId}`.
2. Inspect the signed incident evidence.
3. Send `POST /governance/freeze-requests/{requestId}/review` with `decision` (`approved` or `rejected`) and the standard governance `audit` object.
4. If the request is approved, send `POST /governance/freeze-requests/{requestId}/prepare` with the registered `signerWallet` and `audit`.
5. Review the signing payload through the existing hardware-wallet procedure.
6. Sign through the existing hardware-wallet procedure.
7. Broadcast through the existing authorized hardware-wallet procedure.
8. Report the transaction through `POST /governance/actions/{actionId}/confirm`.
9. Read `GET /governance/freeze-requests/{requestId}` for the actual execution state.

For review, the gateway records the actor, reason, ticket and step-up evidence in the same transaction as the decision. The recorded decision is immutable. For preparation, the gateway re-verifies the request and prepares the exact `pauseTrade(tradeId)` call. Human approval alone cannot broadcast the call.

A reported transaction hash remains pending verification until the existing chain verifier observes it. The read endpoint reports the request, recorded review and latest associated governance action separately.

### Display and paginate containments

`GET /reconciliation/containments` takes `limit` (1–200, default 50) and an opaque `cursor`. The response contains `items` and `nextCursor`.

Use these steps to read all pages:

1. Fetch the first page without a `cursor`.
2. While `nextCursor` is non-null, fetch the next page with that value as `cursor`.

The endpoint orders pages by open time and trade ID. It provides no shared snapshot across pages. Concurrent new incidents can appear on a later refresh. If a page sequence is unfinished or fails, treat the inventory as incomplete.

Each item carries its raw `proof`. Dash uses `VITE_RECONCILIATION_FINDING_PUBLIC_KEYS` to verify the P-256 signature, finding membership, scope, incident binding, rules and clearing evidence independently. This setting contains only public Subject Public Key Info (SPKI) keys.

Before deployment, supply trusted keys in the build configuration. Never obtain a trust key from an evidence response. During rotation, keep the public keys that verify historical evidence. The gateway checks the clock for each action because display verification does not establish action freshness.

## Configuration

### Reconciliation signer

In staging and production, set `RECONCILIATION_FINDING_SIGNER` to `kms:<key ARN>`. ARN means Amazon Resource Name. Only with `COTSEL_ENVIRONMENT=local`, use `local:<label>`. The text after the first colon is the manifest key ID. If `RECONCILIATION_FINDING_SIGNER` is unset, the daemon refuses to start.

For local signing, set `RECONCILIATION_FINDING_SIGNING_KEY` to a base64 PKCS#8 P-256 private key. PKCS means Public-Key Cryptography Standards.

`RECONCILIATION_FINDING_SIGN_TIMEOUT_MS` defaults to `5000`. Use a minimum of 500 milliseconds and a maximum of one quarter of `RECONCILIATION_LEASE_TTL_MS`. Signing runs under the run lease.

### Gateway snapshot age

`GATEWAY_RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS` sets the maximum age of the signed snapshot for actions. The default is `900`. The accepted range is `60..86400`.

### Verification keys

Set `RECONCILIATION_FINDING_PUBLIC_KEYS` to JSON in the form `{"<key id>": "<base64 SPKI DER>"}`. JSON means JavaScript Object Notation. DER means Distinguished Encoding Rules. In staging, use foundation outputs `reconciliation_finding_key_arn` and `reconciliation_finding_public_key`.

Treasury requires `RECONCILIATION_FINDING_PUBLIC_KEYS` with `RECONCILIATION_DB_NAME`. The gateway uses these keys for the trade-unpause guard and containment API. The report CLI and `containment-cli release` also use these keys.

## Deploy signed evidence

The foundation stack creates the signing key and grant. The platform stack reads the foundation output `reconciliation_finding_key_arn`. The release owner must approve the exact artifacts and cutover plan before deployment. Drain an old runtime before applying migrations that its manifest does not contain. Runtime images verify migration history; they do not apply schema changes.

### Check legacy containments

Migration `202611230002` refuses legacy containments in `CONTAINED` or `RECONCILED_PENDING_APPROVAL`. It checks before it creates the signed run table. On refusal, the prior application schema and migration versions remain valid. Resolved legacy incidents keep their original unsigned evidence.

Before you start the signing cutover, use these steps:

1. Check the target database ledger and schema through the approved verifier.
2. If version `202611230002` or table `reconcile_run_manifests` already exists, stop for a reviewed forward migration plan.
3. Run `reconcile:containment list` with the pre-cutover reconciliation image.
4. If the list contains open incidents, resolve them through the existing governed recovery procedure.
5. Before you run the migration task, stop all pre-cutover reconciliation writers.
6. If the task reports `reconciliation_signed_cutover_open_legacy_containment`, stop the cutover.
7. After refusal, verify that the pre-cutover migration history still matches the old image.

If an incident is still open, keep its containment in force. Follow [the scoped containment procedure](reconciliation-run-leases.md#part-2--scoped-containment-pres-11) with the pre-cutover runtime. Retry cutover only after governed recovery. Preserve the legacy records and receipt history.

### Apply and verify

Use [Staging service database migrations](staging-service-migrations.md) for the dedicated migration tasks. Deploy in this order:

1. With owner authorization, apply the approved foundation plan.
2. With owner authorization, apply the approved platform plan.
3. Apply the reviewed reconciliation migrations through the dedicated task.
4. Deploy reconciliation with signing and the `/containments` endpoint.
5. Wait for a signed completed run.
6. Deploy treasury with `RECONCILIATION_FINDING_PUBLIC_KEYS`.
7. Apply the reviewed gateway migrations through the dedicated task.
8. Deploy the complete gateway with `RECONCILIATION_FINDING_PUBLIC_KEYS`.

Reconciliation seals each run that completes after its deployment. Until the first signed run completes, treasury blocks exports with `reconciliation_evidence_unsigned` if the latest run is unsigned. Expect this cutover window to last one daemon interval. If the gateway deploys first, the containment API and trade-unpause approvals fail closed. They return 503 `reconciliation_evidence_unavailable` (`endpoint_missing`) until the reconciliation image provides the endpoint.

During the cutover, publication rechecks any export that started against an unsigned run. That export fails the check. Retry the export against the next signed run. Treasury serves completed exports from their stored context without reassessing them. Runs that predate signing do not affect those exports. Until the first signed run completes, each gate read logs `RECONCILIATION_EVIDENCE_UNSIGNED`.

The local PostgreSQL 16 test used 100,000 scope rows and 100 findings. Sealing took about 32 ms. Verification took about 25 ms per read.

## Recover after an image or migration failure

An earlier image cannot start if its manifest lacks an applied migration. Nullable columns do not change this startup rule. During recovery, preserve the ledger and applied migrations. Keep signatures and treasury verification enabled. Never downgrade treasury to trust unsigned evidence.

If recovery is necessary, use this sequence:

1. Stop new settlement ingress.
2. Stop privileged mutations.
3. Keep signed reconciliation running.
4. Keep treasury verification running.
5. Investigate the failure.
6. Repair forward with the current immutable migration manifest and reviewed application changes.

A compatibility image must preserve every applied migration and verification boundary. Before approving a compatibility image for recovery, rehearse deployment with that image. Local database checks establish no deployed-image rehearsal. See [M6 continuation acceptance](m6-continuation-acceptance.md).

## Respond to a failure

### `reconciliation_findings_signing_failed`

KMS refused or timed out. Reconciliation leaves the run incomplete, keeps the cursor in place and publishes no findings from that run. Reconciliation never publishes unsigned findings. The next run compares the same window again.

To respond, use these steps:

1. Restore the reconciliation task role's access to the key.
2. Check the KMS key state.

### `treasury_reconciliation_evidence_invalid`

The run rows no longer match the signed manifest. Treat this as tampering. Keep the existing rows intact. Use these steps to recover:

1. Open an incident.
2. Preserve the reconciliation database.
3. Rerun reconciliation for the affected window.

The new run publishes new signed evidence.

### `treasury_reconciliation_evidence_unsigned`

This can occur briefly after the first deployment. If it continues beyond the initial cutover, use these checks:

1. Confirm that reconciliation runs with a signer.
2. Check for `reconciliation_findings_signing_failed`.

## Rotate the signing key

Keep the old key and its public-key entry so earlier runs remain verifiable. The key has `prevent_destroy` protection.

Rotate the key in this order:

1. Create the new key.
2. Add its public key to `RECONCILIATION_FINDING_PUBLIC_KEYS`.
3. Switch `RECONCILIATION_FINDING_SIGNER` to `kms:<new key ARN>`.

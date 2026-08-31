# Cotsel legacy GCP baseline — 31 August 2026

## Purpose and status

This is a redacted, dated supersession record for the active legacy GCP lane.
It complements the historical [25 August completion ledger](cotsel-staging-completion-ledger-2026-08-25.md);
it does not amend or erase that earlier evidence.

Overall migration status: **PARTIALLY VERIFIED**.

Programme gate: [#776](https://github.com/Agroasys/Cotsel/issues/776).
No conclusion in this document authorizes a cutover, service shutdown, secret
rotation, data deletion, or GCP decommission.

No secret values, private keys, authenticated RPC URLs, tokens, cookies, or
customer records are included.

## Directly observed active lanes

### Cotsel legacy lane

- Project: `hale-yew-472207-r2`.
- Resource: `cotsel-staging`, `us-central1-a`, public IP `34.10.181.103`.
- Role: public dashboard and Docker-based gateway, auth, oracle, indexer,
  reconciliation, Ricardian, Treasury, PostgreSQL, and Redis services.
- Routing: `cotsel.agroasys.com` resolves directly to the VM.
- Classification: `STALE / LEGACY` but active.
- Disposition: `INTENTIONALLY RETAINED`.

### Backend/session-bridge legacy lane

- Project: `agroasys-1`.
- Resource: `server-1`, `us-central1-f`, public IP `34.172.10.248`.
- Role: legacy backend and session bridge.
- Routing: `ops.agroasys.com` and `backend.agroasys.com` resolve directly to
  the VM.
- Classification: `STALE / LEGACY` but active.
- Disposition: `INTENTIONALLY RETAINED`.

### AWS Cotsel gateway edge

- Account and region: `655177116834`, `ap-south-1`.
- Route: `cotsel.sys.agroasys.com` serves the AWS gateway through CloudFront
  and an internal ALB.
- Classification: `PARTIALLY VERIFIED`.
- Limitation: it is not a replacement for the public GCP dashboard or the GCP
  session bridge.

The retained GCP Cotsel VM runs stateful PostgreSQL and Redis alongside the
application services. It is not an empty rollback shell. Do not infer current
writer authority from a container's health or from a single database activity
counter snapshot.

## Directly observed state and recovery baseline

All following statements are `VERIFIED` by direct, read-only cloud or runtime
queries.

- The Cotsel VM has one attached 50-GB `pd-balanced` disk.
- Its recovery inventory has ready `cotsel-precutover-20260824` and daily
  17–30 August snapshots.
- PostgreSQL has eight service databases: core, auth, gateway, indexer, oracle,
  reconciliation, Ricardian, and Treasury. Reconciliation is 101 MB; the other
  service databases are approximately 7–9 MB.
- Public-schema table counts are core 0, auth 5, gateway 13, indexer 11, oracle
  2, reconciliation 3, Ricardian 2, and Treasury 15. This is an aggregate
  structure baseline, not migration-parity evidence.
- Redis has AOF enabled with `everysec` fsync and configured snapshots. Key
  names and values were not read.
- The backend VM has one attached 45-GB `pd-balanced` disk.
- Its recovery inventory has ready `agroasys-precutover-20260824` and daily
  17–30 August snapshots.

Snapshots support recovery of the retained GCP lane. They do **not** establish
AWS state parity, an RPO/RTO measurement, a data-export checksum, or a safe
decommission decision.

## Inventory limits

The Cotsel project currently has only Compute Engine and Cloud Storage inventory
APIs enabled. Its directly queried Cloud Storage and Pub/Sub inventories were
empty. Cloud SQL, Cloud Run, GKE, Artifact Registry, and Secret Manager
inventory APIs are disabled. Their absence must not be inferred from that
condition: those resource classes are **BLOCKED / UNKNOWN** until an approved
read-only inventory method is available. No APIs were enabled for this audit.

In `agroasys-1`, a CI Terraform-state bucket, CI runner GKE nodes, and a
GitHub-ARC secret metadata record were observed. They are separate from the
Cotsel migration decision and must not be removed under this programme.

## Legacy image provenance limitation

The running Cotsel containers and the `backend-ag` container have locally
observable image digests and creation timestamps, but no
`org.opencontainers.image.revision` or `org.opencontainers.image.source` label.
No source checkout or producing workflow was inferred from the images. Their
release provenance is therefore `STALE / LEGACY` and cannot be used as AWS
candidate or cutover evidence.

## Contract and browser configuration divergence

Issue [#639](https://github.com/Agroasys/Cotsel/issues/639) records the
independently accepted Base Sepolia staging deployment:

- address: `0x95021c0fD0C69BB5Cb991832476B646857632e5d`;
- deployment block: `45914609`; and
- source commit: `6052ed389e885fce3711be0794c8df0df6fe6d95`.

This acceptance does not mean that runtime consumers have converged. The active
AWS gateway task definition still references historical address
`0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`, while the retained GCP dashboard
bundle exposes `0x37F5d97fd9D227dd39391ACfC3C77FDF7c7F742A`. Both are distinct
deployed Base Sepolia contracts. Treat address convergence as `BLOCKED` pending
review, merge, a fresh Terraform plan, independent apply, and runtime reads.

## Required next evidence before a GCP cutover

1. Map every public DNS/Cloudflare origin, callback, CI/CD deployment, external
   allowlist, and service discovery consumer to its actual current target.
2. Map each GCP service's inbound authority, database writer, queue publisher
   and consumer, signer authority, secret identifier, and AWS replacement.
3. Produce database and object-state export/restore manifests where state must
   migrate; compare schema, migration identity, aggregate counts, constraints,
   and approved checksums without exposing customer data.
4. Obtain independent acceptance of a per-service writer freeze, cutover,
   rollback, and credential-rotation sequence.
5. Prove the AWS replacement is live and has passed its relevant work-package
   acceptance before moving traffic or declaring any GCP resource ready to
   decommission.

Until all five conditions are satisfied, no GCP resource may be classified as
`MIGRATED` or `READY TO DECOMMISSION`.

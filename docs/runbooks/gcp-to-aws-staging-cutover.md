# GCP to AWS staging cutover

## Purpose

Move Agroasys and Cotsel staging to AWS as the sole authoritative runtime.

This procedure does not authorize production traffic, real-value settlement, or
Base mainnet activity. It does not delete GCP resources. It defines the
evidence required before the team can remove GCP from the staging request path.

## Decision

Use AWS as the target staging platform. Do not perform a lift-and-shift or an
immediate DNS swap.

GCP remains the authoritative staging state source until the AWS target has
passed data-parity, runtime, authentication, callback, Base Sepolia, and
reconciliation checks. During the approved rollback period, retain GCP as a
controlled recovery estate. Do not allow both estates to accept writes after
cutover.

## Current boundary

The forensic audit recorded the following current state on 2026-08-23:

| Capability                                            | Current GCP state                                                      | Current AWS state                                                           | Cutover disposition                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Agroasys API and operational UI                       | Public backend VM serves `backend.agroasys.com` and `ops.agroasys.com` | ECS API and workers run privately                                           | Provision and validate AWS public edge before DNS cutover                   |
| Cotsel dashboard                                      | Public VM serves `cotsel.agroasys.com`                                 | No validated Cotsel-Dash runtime                                            | Build, deploy, and validate a dedicated AWS dashboard target                |
| Cotsel gateway, auth, oracle, indexer, reconciliation | Ten-container VM includes live state and local images                  | Six containers run in one ECS task                                          | Complete runtime and state parity before cutover                            |
| Cotsel treasury and Ricardian services                | Active on the Cotsel VM                                                | No AWS runtime replacement                                                  | Provision, test, and include in the coordinated release                     |
| PostgreSQL                                            | Local databases contain current backend and Cotsel state               | Private AWS databases exist but are not data-parity proven                  | Controlled export, restore, and reconciliation required                     |
| Redis                                                 | Local Redis instances provide short-lived state                        | Private AWS Redis exists                                                    | Recreate short-lived replay/cache state; do not copy it as settlement truth |
| Public Cotsel system gateway                          | Direct GCP route is retained for dashboard dependencies                | `cotsel.sys.agroasys.com` reaches the AWS private origin through CloudFront | Retain as the proven AWS gateway route                                      |

Treat the GCP database records as authoritative until the cutover gate accepts
their AWS replacement. Do not infer migration completion from running ECS
tasks, DNS records, or matching resource names.

## Observed migration baseline

The following redacted, aggregate-only inventory was collected on 2026-08-23
from the live GCP and AWS private runtimes. `estimated rows` is PostgreSQL's
`pg_stat_user_tables.n_live_tup` total, so it is a comparison signal rather
than a substitute for the required export/restore checksum gate.

| Domain           | GCP source                                                                                                                                                             | AWS target                                                                                                                                             | Disposition                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Cotsel gateway   | `agroasys_gateway`: 13 public tables, approximately 90 estimated rows                                                                                                  | `cotsel_gateway`: 12 public tables, approximately 21 estimated rows                                                                                    | **Not parity-proven.** Schema and aggregate totals differ.                       |
| Agroasys backend | `agroasys_backend`: 87 public tables, approximately 2,042 estimated rows; sampled tables include 72 users, 49 business accounts, 25 ledger transactions, and 23 orders | `agroasys`: 98 public tables, approximately 118 estimated rows; sampled tables include 1 user, 0 business accounts, 0 ledger transactions, and 1 order | **Not parity-proven.** The AWS database is not a migrated copy of the GCP state. |

This baseline is a hard stop for GCP writer disablement, DNS cutover, and
decommission. Perform the Phase 2 export/restore and full parity procedure
before changing that disposition.

### Legacy GCP administration control

On 2026-08-23 the audit found public `0.0.0.0/0` SSH and RDP allow rules in
both legacy GCP projects. This was an active exposure, so it was remediated
before proceeding with the ordinary audit sequence:

- `allow-iap-ssh` allows TCP 22 only from Google IAP
  (`35.235.240.0/20`) at priority 900;
- `deny-public-admin-ports` denies TCP 22 and TCP 3389 from
  `0.0.0.0/0` at priority 1000; and
- Google IAP SSH remained usable while direct public SSH became unreachable
  for both `server-1` and `cotsel-staging`; HTTP remained reachable.

These are manual, temporary GCP controls, not a substitute for AWS migration.
They must remain recorded in the migration ledger until the two legacy projects
are decommissioned or their firewall configuration is brought under approved
infrastructure-as-code management.

## Preconditions

Complete these conditions before a data or DNS cutover.

1. Merge and deploy the reviewed remediation PRs that affect the selected
   runtime release.
2. Rotate any provider credential that was exposed outside approved storage.
3. Record an alert recipient and verify delivery for the AWS critical alarms.
4. Obtain independent acceptance of the Base Sepolia candidate through #639.
5. Provision AWS Cotsel-Dash, treasury, and Ricardian workloads or explicitly
   remove them from the approved staging scope.
6. Confirm one AWS owner for each database, object store, queue, secret, and
   external callback.
7. Schedule a maintenance window and name a cutover operator and independent
   verifier.
8. Create current GCP snapshots and verify the restoration procedure before
   changing writers.
9. Publish a rollback decision rule. Do not use a time-based DNS rollback after
   an irreversible chain event without first reconciling that event.

## Phase 1: establish AWS runtime parity

### Stage 1: create the private runtime definitions

Deploy the Treasury and Ricardian ECS definitions with desired count `0`.
Keep both services stopped until database roles, secret versions, and source-data
evidence are ready. This prevents a new service from creating empty AWS state
or accepting requests before the controlled import.

Each service must have a separate ECS execution role. Each role can read only
its own runtime secret, migration secret, and gateway authentication secret.
The service task role must not read Secrets Manager. The task must use private
subnets, the internal-service security group, and the data-client security
group.

Use private service discovery only after the controlled start gate. Do not add
the Treasury or Ricardian URL to the gateway before both services have passed
their database, authentication, and health checks.

1. Build immutable images from reviewed commits.
2. Record each image digest and source commit in the release evidence packet.
3. Deploy the missing AWS workloads behind private networking.
4. Configure each task from Secrets Manager references. Do not copy secret
   values into Terraform, task-definition environment fields, CI logs, or
   documentation.
5. Apply least-privilege execution-role access for ECS-injected secrets.
6. Deploy dashboard and API edges with canonical HTTPS hosts. Do not use GCP
   origins as an AWS fallback.
7. Verify that every AWS service reports its expected contract address, chain
   ID, database schema version, queue bindings, and runtime release identity.
8. Verify that no deployment uses a mutable image tag as release provenance.

Stop if any workload starts with a historical contract address, public RPC
endpoint, GCP database host, or plaintext credential.

## Phase 2: prepare and prove data parity

1. Put the AWS target in a non-writing validation mode.
2. Capture non-destructive source metrics from every GCP PostgreSQL database:
   schema version, table counts, key financial and settlement aggregates,
   minimum and maximum timestamps, constraints, indexes, and representative
   checksums.
3. Take an approved GCP database snapshot before export.
4. Export PostgreSQL through a controlled private administration path.
5. Restore into the matching AWS database with the expected roles, grants,
   extensions, migrations, and row-level security policies.
6. Run the same source and target metric set. Investigate every mismatch before
   enabling AWS writers.
7. Verify that append-only ledger, settlement, callback, audit, and
   reconciliation records preserve stable identifiers and referential
   integrity.
8. Inventory GCP object storage, if any, and copy only required artifacts with
   object-count and checksum verification.
9. Drain or explicitly retire durable GCP queues. Do not copy messages blindly;
   preserve idempotency and prove that no GCP publisher remains active.
10. Recreate Redis cache and nonce data from the approved runtime configuration.
    Redis is not the migration authority for settlement records.

Record source and target values in a redacted migration evidence packet. Do not
store connection strings, credentials, customer data, or full callback bodies.

## Phase 3: readiness rehearsal

Before moving public traffic, verify the current AWS deployment.

1. Confirm Cotsel gateway, API, worker, dashboard, treasury, Ricardian,
   oracle, indexer, and reconciliation readiness.
2. Confirm backend-to-Cotsel signed authentication, tamper rejection, and
   persistent nonce replay rejection.
3. Cause a real controlled Cotsel callback through the normal sender path.
4. Verify both Base Sepolia providers return chain ID `84532`.
5. Force the primary RPC path to fail in a controlled test. Verify observed
   fallback selection and recovery to primary.
6. Confirm every active contract consumer uses the independently accepted #639
   address and start block.
7. Run a narrow controlled settlement rehearsal. Verify gateway, oracle,
   indexer, callback, ledger, and reconciliation evidence without using real
   commercial value.
8. Confirm alarms route to an operator and that queue/DLQ, indexer lag,
   callback-auth, replay, RPC, and database failure signals are actionable.

The independent verifier must accept this packet before the traffic cutover.

## Phase 4: controlled cutover

1. Announce the maintenance window and stop new GCP-originated settlement
   commitments.
2. Confirm the final GCP source snapshot and the final AWS parity report.
3. Disable GCP application writers in a controlled order. Keep database
   snapshots available.
4. Promote the AWS release using its approved immutable image digests.
5. Confirm AWS workers are the only active writers.
6. Move `backend.agroasys.com`, `ops.agroasys.com`, and
   `cotsel.agroasys.com` to the approved AWS edges.
7. Update third-party callback destinations and allowlists to canonical AWS
   paths.
8. Verify DNS, TLS, origin controls, and direct-origin restrictions.
9. Run the complete post-cutover rehearsal against the deployed AWS revisions.
10. Record the cutover time, release identities, DNS changes, source snapshot,
    parity evidence, and verifier decision.

Do not re-enable GCP writers after an AWS chain or callback event without a
specific reconciliation decision. A simple DNS rollback is not sufficient once
the two estates can observe different settlement facts.

## Rollback

Use rollback only before divergent settlement activity, or after an explicit
reconciliation decision.

1. Stop new AWS settlement commitments.
2. Preserve AWS logs, queue state, callback evidence, database state, and chain
   observations.
3. Determine whether AWS has accepted any callback or chain event after the
   cutover point.
4. If no divergent event exists, restore the approved prior GCP edge and keep
   AWS in evidence-preservation mode.
5. If a divergent event exists, do not restore GCP writers. Reconcile the
   affected records first and record an operator decision.
6. Do not destroy the AWS deployment, GCP VM, disk, snapshot, address, or
   secret during rollback investigation.

## GCP decommission gate

Classify each GCP resource as `MIGRATED`, `INTENTIONALLY RETAINED`, `READY TO
DECOMMISSION`, or `BLOCKED / UNKNOWN`.

Mark a resource ready to decommission only when all conditions are true:

- AWS has a live validated replacement.
- No active DNS, webhook, CI/CD job, or service accesses the GCP resource.
- Data backup, retention, and restoration requirements are met.
- Required credentials have rotated away from the GCP path.
- The approved rollback observation period has ended.
- An authorized reviewer approves the staged disablement.

Disable traffic first. Observe. Disable the workload second. Observe again.
Revoke credentials only after consumers have moved. Delete state last.

## Required evidence

The final migration packet must contain non-secret references for:

- source and target database schema and aggregate comparison;
- source snapshots and restore validation;
- immutable image digests and task-definition revisions;
- AWS secret ARNs and IAM policy references;
- public DNS and edge-origin checks;
- service-auth, callback, replay, RPC, and failover exercises;
- accepted #639 deployment identity and contract-address convergence;
- indexer and reconciliation results;
- queue/DLQ state and alert delivery;
- independent verifier decision; and
- the disposition of every GCP resource.

## Related documents

- [AWS staging platform](aws-staging-platform.md)
- [Runtime truth and deployment guide](runtime-truth-deployment-guide.md)
- [Cotsel forensic completion audit](../readiness/cotsel-forensic-completion-audit-2026-08-22.md)
- [Base Sepolia contract deployment and verification](base-sepolia-contract-deploy-verify.md)

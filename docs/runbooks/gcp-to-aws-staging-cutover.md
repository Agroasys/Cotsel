# GCP to AWS staging cutover

## Purpose

Establish an isolated AWS staging lane for Agroasys and Cotsel.

This procedure does not authorize production traffic, real-value settlement, or
Base mainnet activity. It does not delete GCP resources. It defines the
evidence required before AWS becomes accepted staging truth or GCP is removed
from a request path.

## Decision

On 2026-08-24, the programme selected an explicit **fresh AWS staging**
cutover. AWS is a new Base Sepolia rehearsal lane. It is not a raw copy of the
historical GCP staging estate.

Do not export or restore GCP application, ledger, settlement, callback,
indexer, reconciliation, queue, cache, session, or replay records into the AWS
lane. These records were created against different schemas and historical
contract configurations. A bulk restore would make later settlement evidence
ambiguous.

Keep GCP as the authoritative record for its historical lane and as a retained
recovery estate. AWS can become authoritative only for new AWS staging facts
after its own runtime, authentication, callback, Base Sepolia, contract,
indexer, and reconciliation gates pass.

Do not route a user-facing GCP hostname to an empty AWS database. Do not allow
either lane to consume the other lane's settlement events, callbacks, queues,
or Redis state. A later public-traffic move requires a separate approved
source-data disposition and cutover decision.

## Current boundary

The forensic audit recorded the following current state on 2026-08-23:

| Capability                                            | Current GCP state                                                      | Current AWS state                                                           | Cutover disposition                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Agroasys API and operational UI                       | Public backend VM serves `backend.agroasys.com` and `ops.agroasys.com` | ECS API and workers run privately                                           | Keep historical users and records in GCP until a separate public-data decision |
| Cotsel dashboard                                      | Public VM serves `cotsel.agroasys.com`                                 | No validated Cotsel-Dash runtime                                            | Build a separate AWS dashboard. Do not point it at empty legacy data.          |
| Cotsel gateway, auth, oracle, indexer, reconciliation | Ten-container VM includes live state and local images                  | Six containers run in one ECS task                                          | Prove a clean AWS lane. Do not import historical execution or chain state.     |
| Cotsel treasury and Ricardian services                | Active on the Cotsel VM                                                | No AWS runtime replacement                                                  | Provision private AWS services with new AWS-only state.                        |
| PostgreSQL                                            | Local databases contain current backend and Cotsel state               | Private AWS databases exist but are not data-parity proven                  | Retain GCP as historical evidence. Keep AWS schema and records clean.          |
| Redis                                                 | Local Redis instances provide short-lived state                        | Private AWS Redis exists                                                    | Recreate short-lived replay/cache state; do not copy it as settlement truth    |
| Public Cotsel system gateway                          | Direct GCP route is retained for dashboard dependencies                | `cotsel.sys.agroasys.com` reaches the AWS private origin through CloudFront | Retain as the proven AWS gateway route                                         |

Treat GCP records as authoritative only for the historical GCP lane. Treat
AWS records as authoritative only for accepted AWS staging activity. Do not
infer a migration, data equivalence, or public-traffic authorization from
running ECS tasks, DNS records, or matching resource names.

## Observed migration baseline

The following redacted, aggregate-only inventory was collected on 2026-08-23
from the live GCP and AWS private runtimes. `estimated rows` is PostgreSQL's
`pg_stat_user_tables.n_live_tup` total. This inventory proves the lanes are
materially different. It is preservation evidence, not a migration claim.

| Domain           | GCP source                                                                                                                                                             | AWS target                                                                                                                                             | Disposition                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Cotsel gateway   | `agroasys_gateway`: 13 public tables, approximately 90 estimated rows                                                                                                  | `cotsel_gateway`: 12 public tables, approximately 21 estimated rows                                                                                    | **Not parity-proven.** Schema and aggregate totals differ.                       |
| Agroasys backend | `agroasys_backend`: 87 public tables, approximately 2,042 estimated rows; sampled tables include 72 users, 49 business accounts, 25 ledger transactions, and 23 orders | `agroasys`: 98 public tables, approximately 118 estimated rows; sampled tables include 1 user, 0 business accounts, 0 ledger transactions, and 1 order | **Not parity-proven.** The AWS database is not a migrated copy of the GCP state. |

This baseline is a hard stop for GCP writer disablement, public DNS cutover,
and decommission. It does not block proof of the isolated AWS staging lane.
Do not perform a full export/restore unless a later approved decision requires
historical GCP state to move into AWS.

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
   changing GCP writers or public traffic.
9. Publish a rollback decision rule. Do not use a time-based DNS rollback after
   an irreversible chain event without first reconciling that event.
10. For any selected reference data, approve a field-level mapping, source,
    target, validation query, and owner before copying it.

## Phase 1: establish AWS runtime parity

### Stage 1: create the private runtime definitions

Deploy the Treasury and Ricardian ECS definitions with desired count `0`.
Keep both services stopped until database roles, secret versions, and AWS-lane
evidence are ready. This prevents a new service from accepting requests before
the controlled AWS start gate.

Each service must have a separate ECS execution role. Each role can read only
its own runtime secret, migration secret, and gateway authentication secret.
The service task role must not read Secrets Manager. The task must use private
subnets, the internal-service security group, and the data-client security
group.

Use private service discovery only after the controlled start gate. Do not add
the Treasury or Ricardian URL to the gateway before both services have passed
their database, authentication, and health checks.

### Stage 2: write initial secrets and bootstrap database access

Do not enter secret values in Terraform, task definitions, issue comments, or
chat. Use `scripts/bootstrap-aws-treasury-ricardian-secrets.sh` from a
non-traced administrator shell. The script creates the first version only. It
refuses to replace an existing current version.

AWS cannot atomically write all six secret versions. If a write fails after a
previous write succeeds, inspect each version stage. Do not replace an existing
version. Use `COTSEL_ALLOW_PARTIAL_RECOVERY=true` only to create missing initial
versions after the metadata review confirms that no service has started.

1. Confirm the six target secrets have no `AWSCURRENT` version.
2. Run the script with `AWS_REGION=ap-south-1`.
3. Record only the secret ARNs and creation times.
4. Apply the reviewed database-bootstrap task definition.
5. Run the exact reviewed task without command or environment overrides.
6. Verify the task exit code is `0` and inspect the redacted log stream.
7. Query the new databases with migration and runtime credentials through the
   approved private path.
8. Prove runtime roles cannot create schemas or read the other service database.

Use the dedicated entitlement-verification task for steps 7 and 8. The task
uses only the four Treasury and Ricardian migration/runtime credentials. It
connects from private subnets with `verify-full` TLS. It tests migration schema
creation in a rolled-back transaction. It verifies runtime own-database access.
It verifies runtime schema creation and cross-database connection are denied.
The task writes only pass/fail evidence to its encrypted CloudWatch log group.
Do not use task command or environment overrides.

The bootstrap task verifies the pinned public AWS RDS root bundle before it
opens a `verify-full` PostgreSQL connection. It reads the RDS master secret and four service database
secrets. It creates only `cotsel_ricardian` and `cotsel_treasury`, their
migration roles, their runtime roles, and least-privilege database grants. The
task does not write secret versions and does not start a service. Do not run it
with command overrides.

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

## Phase 2: preserve GCP state and establish AWS-lane boundaries

1. Capture non-destructive GCP metrics and current snapshots before any GCP
   writer, DNS, or resource change.
2. Classify every GCP resource as `MIGRATED`, `INTENTIONALLY RETAINED`,
   `READY TO DECOMMISSION`, or `BLOCKED / UNKNOWN`.
3. Confirm every AWS service uses AWS database, Redis, queue, object-storage,
   secret, and callback endpoints. Reject GCP endpoint configuration.
4. Copy only an explicitly approved non-financial reference record. The mapping
   must name the source, target, owner, validation query, and rollback action.
5. Do not copy ledger, settlement, callback, indexer, reconciliation, queue,
   session, cache, nonce, or replay records into AWS.
6. Create AWS database schemas through their reviewed migrations. Do not use a
   GCP database dump as a schema or data bootstrap.
7. Inventory GCP objects and preserve required evidence artifacts. Copy an
   artifact only after checksum validation and documented data ownership.
8. Drain or explicitly retain GCP durable queues. Do not copy messages into
   AWS. Preserve idempotency evidence and identify every active publisher.
9. Recreate AWS Redis cache and replay state from approved runtime
   configuration. Redis is not settlement migration authority.
10. Record the source inventory, selected reference-data mappings, and AWS
    isolation checks in a redacted evidence packet.

Do not store connection strings, credentials, customer data, or full callback
bodies in the evidence packet.

## Phase 3: readiness rehearsal

Before treating AWS as an accepted clean staging lane, verify the current AWS
deployment.

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
7. Run a narrow controlled settlement rehearsal with new AWS-only test facts.
   Verify gateway, oracle, indexer, callback, ledger, and reconciliation
   evidence without real commercial value.
8. Confirm alarms route to an operator and that queue/DLQ, indexer lag,
   callback-auth, replay, RPC, and database failure signals are actionable.

The independent verifier must accept this packet before AWS becomes accepted
staging truth. This acceptance does not move user-facing GCP traffic.

## Phase 4: future public-traffic cutover

The fresh-staging decision does not authorize this phase. Before moving any
current public GCP hostname, the programme must choose and approve one of these
paths:

- a governed historical-data migration with full reconciliation; or
- a managed retirement of the public GCP product surface with explicit user and
  record-retention handling.

Do not use an empty AWS database as a substitute for either path.

1. Announce the maintenance window and stop new GCP-originated settlement
   commitments.
2. Confirm the final GCP source snapshot and the approved source-data
   disposition.
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
    source-data disposition, and verifier decision.

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

- GCP source inventory, AWS clean-lane baseline, and any approved
  reference-data mapping;
- source snapshots and selected reference-data validation;
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

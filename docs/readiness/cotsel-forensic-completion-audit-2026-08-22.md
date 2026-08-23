# Cotsel forensic completion audit — 2026-08-22

Status: in progress. This document records current evidence. It does not accept
the staging release or close Cotsel issue #639.

## Batch 0 — reconstruction ledger

### Repositories and change surfaces

- Cotsel baseline: `origin/main` at
  `215d9469d78171d9c02f9fa85c006ac7d7f4dab3`.
- Cotsel evidence PR: [#713](https://github.com/Agroasys/Cotsel/pull/713)
  at `3745f370f44432b4eb474df9324b26de4296560f`.
- Cotsel AWS foundation PR:
  [#712](https://github.com/Agroasys/Cotsel/pull/712), merged as
  `9ed4f520eea35e7a5a9095f19f6fd9cd35f8c0ae`.
- Backend RPC failover PR:
  [#567](https://github.com/Agroasys/agroasys-backend/pull/567), merged to
  `develop` as `8915628ceba6e73b195252e6ede900f11bf5a46d`.
- Contract acceptance issue:
  [#639](https://github.com/Agroasys/Cotsel/issues/639), open and without an
  independent acceptance decision.

The normal backend worktree contains unrelated uncommitted work. This audit
does not modify that worktree.

### Claims versus evidence matrix

| Previous claim                                                        | Current evidence                                                                                                                                                                                                  | Classification                        | Required follow-up                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Task E evidence is committed                                          | `docs/readiness/task-e-settlement-boundary-staging-evidence-2026-08-21.md` is on Cotsel `main` at `215d946`                                                                                                       | VERIFIED as repository evidence       | Re-run the live proof against the current task revision in Batch 20.                                               |
| Backend RPC fallback code is merged                                   | Backend PR #567 merged to `develop`; its hosted checks passed on the merged head                                                                                                                                  | VERIFIED as code integration          | Prove deployed backend revision and runtime fallback behavior.                                                     |
| Cotsel AWS foundation is managed by Terraform                         | S3 state `cotsel/staging-platform/terraform.tfstate` exists at serial 13 and tracks the foundation, CloudFront, ECS service, task definition, IAM, ECR, logs, KMS, security groups, and secret identities         | PARTIALLY VERIFIED                    | Reconcile Terraform state task definition `:4` with live task definition `:13`.                                    |
| Current Cotsel runtime is the Terraform-managed release               | Terraform state tracks service/task definition `:4`; ECS runs `:13`; CloudTrail records manual `UpdateService` calls by `Aston.S` through revisions 5–13                                                          | MISCONFIGURED                         | Explain and reconcile the manual drift through the canonical IaC path.                                             |
| The Base Sepolia evidence packet is committed and accepted            | Evidence is only in open PR #713; #639 remains open; PR review decision is `REVIEW_REQUIRED`                                                                                                                      | PARTIALLY VERIFIED                    | Independently review evidence, merge only after correction, and record explicit acceptance or rejection.           |
| The deployed runtime is pinned to reviewed source                     | Gateway, indexer pipeline, and indexer GraphQL use merged commit `21a397...`; auth and reconciliation use image tag `1049672`; oracle uses `47016df`; the latter two commits are not contained by a remote branch | PARTIALLY VERIFIED                    | Bind every image digest to remotely available reviewed source and release evidence.                                |
| The evidence packet describes the current running task                | The packet records task `1e534...`; ECS currently runs task `d91b0...`, started after the packet was written                                                                                                      | STALE / LEGACY                        | Regenerate live evidence after remediation.                                                                        |
| Every relevant container has a meaningful health check                | Auth, indexer GraphQL, oracle, and reconciliation have container checks; gateway and indexer pipeline report `UNKNOWN`                                                                                            | PARTIALLY VERIFIED                    | Establish health/readiness coverage for the two unverified containers.                                             |
| Database TLS is safely configured                                     | Gateway uses `DB_SSL_MODE=require`; auth, indexer, oracle, and reconciliation set `NODE_TLS_REJECT_UNAUTHORIZED=0` and `DB_SSL_MODE=no-verify`                                                                    | MISCONFIGURED                         | Restore certificate verification without breaking RDS connectivity.                                                |
| Secrets are injected through ECS secret references                    | Revision 13 uses Secrets Manager references for database, HMAC, RPC, and signer values                                                                                                                            | VERIFIED for injection structure      | Audit values for leakage, IAM readers, KMS policy, Terraform state, logs, and Git history without printing values. |
| Service-auth credentials are distinct                                 | Separate ingress and callback secret ARNs are referenced by the current task definition                                                                                                                           | PARTIALLY VERIFIED                    | Prove distinct values by redacted digest comparison and rerun both live directions.                                |
| Replay protection is persistent/shared                                | Task E documentation records Postgres ingress nonces and Redis callback nonces                                                                                                                                    | PARTIALLY VERIFIED                    | Trace current deployed implementation and prove cross-restart or cross-task behavior.                              |
| Primary and fallback RPC endpoints exist                              | Both secret ARNs exist and are referenced by gateway, indexer, oracle, and reconciliation                                                                                                                         | PARTIALLY VERIFIED                    | Re-run chain ID, advancing block, representative read, failover, recovery, and observability checks.               |
| Base Sepolia contract deployment is accepted staging truth            | Transaction, address, block, compiler, and artifact metadata are recorded, but the record is unmerged and independent acceptance is absent                                                                        | PARTIALLY VERIFIED                    | Clean rebuild, bytecode/provenance comparison, role checks, runtime convergence, and independent review.           |
| GCP migration is complete                                             | PR #712 explicitly retained GCP until AWS acceptance. Two accessible GCP projects remain active. No current migration parity evidence was found in Batch 0                                                        | NOT IMPLEMENTED as a completion claim | Perform the mandatory GCP inventory and produce a per-resource migration disposition.                              |
| Another engineer can reproduce the deployed state from source and IaC | Current runtime contains manual task-definition drift and images from commits unavailable on a remote branch                                                                                                      | NOT IMPLEMENTED                       | Reconcile IaC and release provenance before completion.                                                            |

### Current AWS runtime identity

- Account: `655177116834`.
- Region: `ap-south-1`.
- Cluster: `cotsel-staging`.
- Service: `cotsel-staging-gateway`.
- Live task definition: `cotsel-staging-gateway:13`.
- Live task: `d91b0ac20efb4e20b4ed804f5e5c70a2`.
- Desired/running/pending: `1/1/0`.
- Public IP assignment: disabled.
- Terraform state task definition: `cotsel-staging-gateway:4`.
- Terraform state serial: `13`.

### Current GCP access baseline

The authenticated account can enumerate two active projects:

- `agroasys-1` (`350891341642`).
- `hale-yew-472207-r2` (`834462735026`).

Cloud Run, Cloud SQL, Secret Manager, and Artifact Registry APIs are disabled in
both projects. This does not prove that the projects contain no relevant
resources. Batch 3 must inventory enabled services, IAM, storage, networking,
DNS, functions, queues, and historical configuration before assigning a
migration disposition.

### Batch 0 conclusion

The previous overall completion claim is false. Repository evidence, cloud
runtime, and acceptance state do not converge. The most material current gaps
are Terraform/runtime drift, unreviewed image provenance, disabled TLS
verification in several containers, stale live evidence, unaccepted contract
evidence, and an unperformed GCP migration disposition audit.

## Batch 1 — repository and configuration truth

### Active configuration map

- Cotsel `main` validates settlement runtime, Base chain ID, escrow and USDC
  addresses, RPC endpoints, signed ingress, signed callbacks, and nonce timing in
  the service-specific configuration loaders. The live task definition supplies
  the required values through a mixture of plaintext non-secret configuration
  and Secrets Manager references.
- Backend `develop` defines the Cotsel gateway URL, directional HMAC credentials,
  callback timing, Base chain ID, RPC primary/fallback, escrow address, and USDC
  address. The repository Terraform wires the service-authentication values, but
  live deployment truth remains to be established in the AWS runtime audit.
- Cotsel-Dash requires chain, RPC, escrow, USDC, and authentication configuration
  for connected mode. These are Vite browser values; an authenticated managed RPC
  endpoint must not be embedded there because Vite variables are public client
  configuration.

### Findings

| Finding                                                                            | Evidence                                                                                                                                                                                                                               | Classification                        | Required remediation                                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The accepted-candidate deployment report is outside the canonical path             | PR #713 adds `reports/deploy/base-sepolia/agroasysescrow-deploy.json`; runtime and release tooling read `contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json`, which still contains the historical `0x8e1e...` deployment | MISCONFIGURED                         | Move the new evidence to the canonical `contracts/reports` path, remove the duplicate root report, and rerun evidence consumers.                         |
| Deployment evidence output depends on process working directory                    | `baseDeploymentConfig.ts` defaults to relative `reports/deploy/<runtime>` while `deploymentSourceIdentity.ts` excludes only `contracts/reports/deploy/**/*.json`                                                                       | MISCONFIGURED                         | Anchor the evidence path to the contracts workspace/repository contract and add a regression test for invocation from the repository root and workspace. |
| Cotsel Terraform can regress the current live runtime                              | `gateway-runtime.tf` declares one gateway container, pre-contract mode, no RPC or accepted contract values; live revision `:13` has six containers, RPCs, accepted contract, oracle, indexer, and reconciliation                       | MISCONFIGURED                         | Reconstruct revision `:13` declaratively and review a no-regression Terraform plan before any apply.                                                     |
| Canonical repository documentation still marks the contract unpinned               | Release charter and golden journeys reference the historical canonical report and an unpinned address while ECS uses `0xB594...`                                                                                                       | STALE / LEGACY                        | Update only after provenance and independent acceptance are proven.                                                                                      |
| The runtime example carries a stale indexer start block                            | `.env.runtime.example` uses `41078828`; the candidate deployment and live ECS use block `45807259`                                                                                                                                     | STALE / LEGACY                        | Replace the example with an explicit placeholder or the accepted block only after acceptance; do not permit it to act as runtime truth.                  |
| Canonical Hardhat networks silently fall back to public RPC endpoints              | `contracts/hardhat.config.ts` defaults Base Sepolia and Base mainnet RPCs to public endpoints when managed RPC variables are missing                                                                                                   | MISCONFIGURED for governed deployment | Make canonical deployment fail closed when the managed RPC input is absent while preserving an explicit local/read-only diagnostic path if needed.       |
| Historical Polkadot identity remains only in schema migrations                     | Active package manifests contain no Polkadot dependency; remaining references are schema/migration history, including removal of legacy extrinsic identity fields                                                                      | VERIFIED as historical                | Preserve migration history; do not delete it as active configuration cleanup.                                                                            |
| Previously shared RPC credentials are still the live secret versions               | The current task definition reads the Infura and Alchemy secret ARNs created during the prior session, and no later rotation is recorded after the authenticated URLs were disclosed                                                   | MISCONFIGURED — credential exposure   | Rotate both provider credentials, update secret versions, force a new task revision, validate primary/fallback, then revoke the disclosed provider keys. |
| Previously disclosed test-wallet keys do not control the candidate deployment      | AWS public wallet addresses match the candidate oracle, treasury, relayer, and three admin roles; they differ from the three public wallets whose test keys were disclosed previously                                                  | VERIFIED for the candidate role set   | Retain the candidate wallets in approved storage and still complete IAM, log, Git-history, and on-chain role verification.                               |
| Backend contains a hard-coded historical escrow address in a database-proof script | `scripts/settlement-activity-database-proof.ts` pins `0xd2FB...`; runtime smoke configuration is otherwise environment-driven                                                                                                          | STALE / LEGACY tooling                | Parameterize or retire the proof script after confirming it is not used by active CI/runtime.                                                            |

### Batch 1 conclusion

Repository and runtime configuration are not currently reproducible from the
canonical source paths. The highest-risk defects are exposed live RPC
credentials and Terraform that can roll the live six-container task back to a
pre-contract single-container definition. Contract evidence is split across two
paths, so canonical health/release tooling still evaluates the historical
deployment. No remediation has been applied yet; provider credential rotation
is the only immediate security remediation and requires the signed-in provider
consoles.

## Batch 2 — AWS inventory and IaC drift

### Account and regional footprint

- AWS Organizations is enabled with all features, but contains only account
  `655177116834` (`Agroasys`). Production, staging, security/logging, and shared
  services are not separated into different accounts.
- The active application and Cotsel staging workloads are in `ap-south-1`.
  `eu-north-1` retains the Terraform state buckets, the historical backend ECR
  repository, and three Cotsel settlement secrets that are scheduled for
  deletion. `us-east-1` owns the CloudFront certificates, WAF resources, and
  global edge resources.
- No active EC2 instances, Lambda functions, EKS clusters, API Gateway APIs, or
  Aurora clusters were found in the active workload inventory. The data tier is
  an RDS PostgreSQL instance rather than Aurora.

### Live workload and data inventory

| Surface       | Current AWS truth                                                                                                                                                                                                   | Classification                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Backend ECS   | Cluster `agroasys-staging`: API desired/running `2/2`; five workers each `1/1`; all private Fargate tasks use digest `sha256:f46b8c...`                                                                             | VERIFIED                                                                                |
| Cotsel ECS    | Cluster `cotsel-staging`: one private Fargate task at task definition `:13` with gateway, auth, oracle, indexer pipeline, indexer GraphQL, and reconciliation containers                                            | VERIFIED as runtime existence                                                           |
| Target health | Both backend API targets and the single Cotsel gateway target are healthy                                                                                                                                           | VERIFIED for load-balancer health only                                                  |
| PostgreSQL    | `agroasys-staging`, PostgreSQL 16.13, private, encrypted, Multi-AZ, seven-day backups, deletion protection enabled                                                                                                  | VERIFIED                                                                                |
| Redis         | `agroasys-staging`, two nodes, Multi-AZ/failover, TLS and at-rest encryption enabled, no Redis auth token, restricted to the data-client security group                                                             | PARTIALLY VERIFIED; runtime TLS and replay behavior remain to be tested                 |
| Queues        | Three FIFO queues plus FIFO DLQs for compliance callbacks, reconciliation, and settlement callbacks; 300-second visibility, five receives before DLQ, 14-day retention, SQS-managed encryption; all currently empty | VERIFIED as queue configuration                                                         |
| EventBridge   | No custom rule was returned on the default event bus                                                                                                                                                                | VERIFIED                                                                                |
| S3 documents  | KMS encrypted, versioned, public access blocked, access logging enabled, but currently contains zero objects                                                                                                        | VERIFIED; migration parity remains unproven                                             |
| ECR           | Backend repositories exist in both `eu-north-1` and `ap-south-1`; eight KMS-encrypted Cotsel repositories exist in `ap-south-1`; immutable tags and scan-on-push are enabled                                        | VERIFIED; the old regional backend repository requires a consumer/decommission decision |

### Network and edge findings

- Both ALBs are internal and both ECS clusters use private subnets with public IP
  assignment disabled.
- Cotsel ingress is CloudFront VPC origin to an HTTPS-only internal ALB. The ALB
  admits the AWS-managed CloudFront origin prefix list only, and the task admits
  port 3600 from the ALB security group only. Direct Internet origin reach was
  not found.
- The Cotsel distribution has no WAF association and CloudFront access logging
  is disabled. The backend distribution has a WAF but also has access logging
  disabled.
- Two NAT gateways and two fixed Elastic IPs provide egress across two
  availability zones. Only an S3 gateway VPC endpoint exists; Secrets Manager,
  SQS, and Logs use NAT egress.
- Cotsel service egress permits HTTPS to `0.0.0.0/0`; this is consistent with
  managed RPC/callback access through NAT but provider restrictions have not yet
  been reconciled with the two EIPs.

### Runtime and IaC drift

A live, read-only Terraform plan was run from Cotsel `main` against the current
state and account. It returned exit code `2` with `0 to add, 2 to change, 0 to
destroy`. Applying it would:

1. change the ECS service from live task definition `:13` back to tracked task
   definition `:4`; and
2. remove the execution role's access to the auth, oracle, indexer, and
   reconciliation images, logs, RPC secrets, database secrets, oracle signer,
   and service-auth secrets.

This proves the live release was installed outside the current declarative root
and that the current canonical Terraform apply is unsafe. No apply was run.

### Security and operational control gaps

- No CloudTrail trail, GuardDuty detector, Security Hub subscription, AWS Config
  recorder, AWS Backup plan, SNS topic, or AWS Budget was found.
- Backend Container Insights is disabled while its `no-running-tasks` alarms use
  `ECS/ContainerInsights`; those alarms are `INSUFFICIENT_DATA`.
- The non-autoscaling RDS, Redis, SQS, and task-count alarms have no alarm action
  or notification destination. They do not notify an operator.
- Cotsel Container Insights retention is one day. PostgreSQL logs have no
  retention limit. Cotsel application log groups are retained for 30 days.
- Cotsel CloudWatch log groups have no metric filters for authentication,
  replay, RPC failover, indexer lag, reconciliation drift, or callback failure.
- The live gateway has mutations and gasless execution disabled. That is a
  fail-closed posture, but it means the full settlement-execution path has not
  been demonstrated by the deployed configuration.
- Four Cotsel service containers still disable TLS certificate verification for
  PostgreSQL; this remains a live remediation item.

### Batch 2 conclusion

The AWS footprint and active staging architecture are now identified, but the
batch is PARTIALLY VERIFIED rather than complete. The decisive blockers are the
unsafe Terraform/runtime drift, exposed RPC credentials awaiting provider
rotation, missing operator notification paths, disabled database certificate
verification, and incomplete provenance for several Cotsel images. IAM policy
semantics and secret-reader boundaries are deferred to the dedicated Batch 5
audit. No AWS resource was created, modified, disabled, or deleted in this
batch.

## Batch 3 — GCP inventory and migration disposition

### Projects, identities, and resource model

- The active `gcloud` identity can inspect two Agroasys-owned projects:
  `agroasys-1` (`350891341642`) and `hale-yew-472207-r2`
  (`834462735026`).
- Each project contains one running public Compute Engine VM on the default VPC.
  Neither project contains a GCP load balancer, managed instance group, Cloud
  Storage bucket, or Cloud DNS zone. Cloud Run, Cloud SQL, Secret Manager,
  Pub/Sub, Artifact Registry, Cloud Functions, Cloud Scheduler, Cloud Tasks, and
  Cloud KMS APIs are disabled.
- Both VMs run under their project's default Compute Engine service account.
  The service accounts have no user-managed key objects, but each default
  service account holds project-level `Editor`. The VM access scopes are narrower
  than that IAM role, but the project role remains unnecessarily broad.
- Both default VPCs retain Internet-wide SSH and ICMP rules. The Cotsel project
  separately permits ports 80 and 443 from the Internet. The Agroasys project's
  rule named `default-allow-ssh` unexpectedly also permits 80 and 443 in addition
  to 22.
- Backend GitHub Actions still stores secrets named `GCP_PROJECT_ID`,
  `GCP_SA_KEY`, `GCE_INSTANCE_NAME`, and `GCE_INSTANCE_ZONE`. Current `develop`
  workflows and application source do not reference them. Because the GCP
  service accounts have no current user-managed keys, `GCP_SA_KEY` is a stale
  credential candidate, but it has not been deleted pending the later credential
  and rollback audit.

### Live GCP workloads and state

| Resource                                                              | Current purpose and evidence                                                                                                                                                                                                                                                                                                                                                          | AWS target status                                                                                                                                                        | Disposition                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `agroasys-1/server-1`                                                 | Public `e2-standard-2` VM in `us-central1-f`; runs backend, PostgreSQL, Redis, and Mailhog containers. `backend.agroasys.com` and `ops.agroasys.com` resolve to its external IP. Backend produced 1,368 log lines in the sampled hour. The deployed Git checkout is dirty and uses a local `backend-ag:latest` image without a registry digest.                                       | AWS backend ECS, RDS, Redis, and mail configuration exist, but the public GCP hostnames and state parity have not moved or been proven.                                  | **BLOCKED / UNKNOWN**                                                                                      |
| `agroasys-1/instance-20260408-102022`                                 | Attached 45 GiB balanced persistent boot disk. Docker volumes include active PostgreSQL and Redis data plus several large anonymous volumes. Fourteen current daily disk snapshots were found.                                                                                                                                                                                        | AWS RDS and Redis exist; database/cache parity and rollback requirements are unproven.                                                                                   | **BLOCKED / UNKNOWN**                                                                                      |
| `hale-yew-472207-r2/cotsel-staging`                                   | Public `e2-standard-2` VM in `us-central1-a`; runs gateway, auth, oracle, treasury, reconciliation, two indexer containers, Ricardian, PostgreSQL, and Redis. `cotsel.agroasys.com` still serves its dashboard. Gateway, oracle, and reconciliation produced logs during the sampled hour. Containers come from two different dirty local Cotsel checkouts and local `latest` images. | AWS runs gateway, auth, oracle, reconciliation, and indexer in one ECS task. AWS does not currently run treasury or Ricardian. State and behavioral parity are unproven. | **BLOCKED / UNKNOWN**                                                                                      |
| `hale-yew-472207-r2/cotsel-staging` disk and `cotsel-static-ip`       | Attached 50 GiB balanced boot disk, static public IP, 233 MiB PostgreSQL Docker volume and 53 MiB Redis volume. Nineteen snapshots exist, including five for a predecessor disk and fourteen current daily snapshots.                                                                                                                                                                 | AWS RDS/Redis exist, but data parity, active writers, and rollback dependencies remain unproven.                                                                         | **BLOCKED / UNKNOWN**                                                                                      |
| `cotsel.sys.agroasys.com` ingress                                     | Public DNS now resolves to AWS CloudFront and the AWS health route returns 200. The GCP Caddy virtual host remains configured but is no longer the public DNS origin.                                                                                                                                                                                                                 | AWS CloudFront, internal ALB, and private ECS target are live.                                                                                                           | **MIGRATED** for public DNS/ingress only; the old GCP route is **STALE / LEGACY** until host decommission. |
| `cotsel.agroasys.com` dashboard                                       | Public DNS resolves directly to the Cotsel GCP VM and returns HTTP 200. Its deployed browser bundle calls AWS `cotsel.sys.agroasys.com`, but also calls GCP-hosted `ops.agroasys.com`.                                                                                                                                                                                                | No validated AWS Cotsel-Dash deployment was found.                                                                                                                       | **BLOCKED / UNKNOWN**                                                                                      |
| Default VPCs, firewall rules, default service accounts, and snapshots | Support the still-live VMs and their rollback posture. They are not standalone migration successes.                                                                                                                                                                                                                                                                                   | AWS equivalents exist only for portions of the workload.                                                                                                                 | **INTENTIONALLY RETAINED** until workload/state migration and decommission gates pass.                     |

### External dependency truth

- `backend.agroasys.com` and `ops.agroasys.com` resolve to
  `34.172.10.248`, the Agroasys GCP VM.
- `cotsel.agroasys.com` resolves to `34.10.181.103`, the Cotsel GCP VM,
  and returns the live dashboard.
- `cotsel.sys.agroasys.com` and `api.staging.agroasys.com` resolve to AWS
  CloudFront distributions.
- The deployed Cotsel dashboard bundle calls the AWS Cotsel system API but still
  calls `https://ops.agroasys.com/api/v1/session-exchange/cotsel`, so the user
  authentication/session path remains cross-cloud.

### Batch 3 conclusion

The prior claim that GCP had been migrated is **NOT IMPLEMENTED** as an
end-to-end migration claim. The public Cotsel system ingress has moved to AWS,
but backend/operations, Cotsel-Dash, treasury, Ricardian, PostgreSQL, Redis, disk
snapshots, and rollback state remain on live GCP VMs. No resource has been
deleted or disabled. Batch 4 must determine database/state parity and whether
either GCP VM still accepts writes that are absent from AWS.

## Batch 4 — stateful data migration verification

Status: **PARTIALLY VERIFIED**. The active GCP and AWS database/cache states
were compared through read-only queries. The result is a verified fresh-AWS
staging posture, not a completed data migration. The decision to intentionally
start AWS staging clean is not yet recorded in the repository runbook, and the
GCP Cotsel indexer/reconciliation databases remain active writers.

### GCP database and cache truth

- The Agroasys VM has database `agroasys_backend` with 79 application tables.
  Representative exact counts include 72 users, 23 orders, 25 ledger
  transactions, 52 ledger entries, seven settlement intents, and 442 request
  logs. No `_prisma_migrations` table exists even though the current backend
  release path uses `prisma migrate deploy`; therefore its migration provenance
  cannot be inferred from this database alone.
- The Cotsel VM has separate auth, gateway, indexer, oracle, reconciliation,
  Ricardian, and treasury databases. Exact counts include 25 gateway settlement
  execution events, 25 callback deliveries, nine handoffs, 155,641
  reconciliation runs, 305,805 reconciliation run/trade rows, two indexed
  trades, and two treasury ingestion-state rows.
- The Cotsel GCP indexer and reconciliation databases are receiving current
  writes. `overview_snapshot.last_indexed_at` and the latest reconciliation run
  advanced during this audit on 2026-08-22. This is not a dormant rollback
  database.
- GCP Redis is also live: Agroasys has nine keys and Cotsel has two expiring
  keys. Both use AOF and successful RDB snapshots, but each is a single local
  Redis master with no replica.
- Canonical schema-only SHA-256 fingerprints were captured for every GCP
  database. They can be compared only after the AWS-side schema dump is
  collected through a private-network execution path.

### Active GCP split-brain configuration

The Cotsel VM itself is not contract-converged:

- gateway: chain `84532`, escrow `0xd2FB...20d4`;
- oracle: chain `84532`, escrow `0x5439...DDA7`;
- indexer: contract `0x5439...DDA7`, start block `41078828`;
- reconciliation: chain `84532`, escrow `0x5439...DDA7`;
- all four use the Coinbase developer RPC host and have no configured fallback;
- the indexer currently reports block `45814881` against that historical
  deployment.

These values differ from the AWS candidate `0xB594...` deployment. This is both
a state-migration blocker and an active contract-address convergence defect.

### AWS database and cache truth

- AWS identity was re-established as the SSO `AdministratorAccess` role in
  account `655177116834`. The private workloads queried below are in
  `ap-south-1`; the CLI profile's default region remains `eu-north-1` and was
  not used as runtime evidence.
- A disposable read-only task based on the currently deployed backend API task
  definition queried Aurora and ElastiCache from the same private network path.
  AWS database `agroasys` has 82 completed Prisma migrations, but only one
  user, one order, 11 request logs, and no audit events, ledger entries, or
  settlement intents. The GCP backend has materially different historical
  counts (72 users, 23 orders, 442 request logs, 84 audit events, 52 ledger
  entries, and seven settlement intents).
- The AWS backend Redis replication group had 24 keys, 16 with expiry, and a
  live replica. This is not key-for-key parity with the single-node GCP Redis
  instance, which had nine keys. The audit did not read cache values.
- Cotsel read-only evidence tasks were launched from exact live task definition
  `cotsel-staging-gateway:13` in the production-equivalent private subnets and
  security groups. Their aggregate results were:

  | Database                |                     Public tables | Representative live counts                                                  |
  | ----------------------- | --------------------------------: | --------------------------------------------------------------------------- |
  | `cotsel_gateway`        |                                12 | callbacks `0`; execution events `0`; handoffs `0`; service-auth nonces `0`  |
  | `cotsel_auth`           |                                 5 | profiles `0`; sessions `0`; admin/nonces `0`                                |
  | `cotsel_indexer`        | 17 migrations plus runtime tables | trades `0`; trade events `0`; oracle events `0`; one bootstrap overview row |
  | `cotsel_oracle`         |                                 2 | HMAC nonces `0`; triggers `0`                                               |
  | `cotsel_reconciliation` |                                 3 | runs `0`; run/trade rows `0`; drifts `0`                                    |

- Reproducible ECS evidence task IDs were `a9ac2f9167524fa8834eb2ce0a4edbdf`
  (backend), `68345ad709d347e698e856c89d46822a` (indexer),
  `c56603f85abf44a7bc7324cbf16ef709` (gateway),
  `1e1a2b6d2f134c62947163f7db391db8` (auth),
  `4de7203d59cd4b47a6c6c4c6b4556fde` (oracle), and
  `fcbd9b58f1b1400e95d0d18d994c9aae` (reconciliation). Each selected query
  container exited `0`; no application rows or secret values were emitted.
- The currently running Cotsel service task is
  `078107afa33449579c666804fe1a6148`, started from revision 13 on 2026-08-22.
  It replaced the earlier service task independently of these audit tasks.
- The existing backend task definition `agroasys-staging-db-role-bootstrap:4`
  cannot currently start: its execution role is denied
  `secretsmanager:GetSecretValue` for the bootstrap credential. Evidence task
  `81d9cc831a2b4d5296794c017910890e` failed before running any query. This is an
  IAM/runtime defect for Batch 5, not evidence of database failure.
- Aurora is private, encrypted, Multi-AZ, protected from deletion, and has a
  seven-day backup window. These controls protect the AWS dataset; they do not
  make it a migrated copy of GCP.

### Batch 4 conclusion

The completion claim "GCP state was migrated to AWS" is **NOT IMPLEMENTED**.
AWS is demonstrably a fresh controlled staging environment while GCP retains
different historical state and, for Cotsel indexer/reconciliation, continues to
receive new state against historical contract configuration. No automatic
database copy should be performed: importing those split-brain records into the
new contract lane without a governed reconciliation procedure would corrupt the
meaning of staging evidence.

The safe disposition is:

1. record and approve AWS as an intentionally clean staging initialization;
2. stop external traffic and active publishers to the GCP staging lane only
   after the AWS authentication, RPC, contract, indexer, and reconciliation
   proofs pass;
3. preserve GCP database/snapshot exports for the rollback window;
4. compare/export historical evidence that must be retained; and
5. decommission GCP in a later controlled sequence after proving no consumers
   remain.

No database, cache, snapshot, service, DNS record, or application record was
changed during Batch 4.

## Batch 5 — AWS identity, IAM, and secret audit

Status: **PARTIALLY VERIFIED**. The runtime secret-reader separation and both
directional settlement credentials are now proven. The remaining defects are a
non-runnable, manually registered database-role bootstrap task; an unsafe local
secret bootstrap script; disabled GitHub secret scanning; and stale evidence
that still assigns roles to wallet identities whose keys were disclosed outside
the approved store.

### Verified IAM reader model

- Live Cotsel task definition `cotsel-staging-gateway:13` uses ECS
  `secrets.valueFrom` for database credentials, settlement ingress/callback
  credentials, gateway-to-oracle credentials, managed RPC endpoints, and the
  oracle signer secret. Therefore the ECS **execution role** is the startup
  secret reader. The application task role has no inline or attached policy.
- The Cotsel execution role grants `GetSecretValue` only for the exact 16 live
  secret ARNs and `kms:Decrypt` only for the Cotsel staging KMS key. Its
  permissions boundary is
  `agroasys-cotsel-staging-service-role-boundary`. ECR image pulls and log
  writes are likewise resource-scoped except for the unavoidable account-level
  `ecr:GetAuthorizationToken` action.
- Backend ECS follows the same injection model. The shared execution role reads
  only the runtime database and app-config secret ARNs; the application task
  roles do not read Secrets Manager. Runtime task-role permissions are
  lane-specific: the API alone has document storage access and only the
  critical-job worker has SQS access.
- AWS IAM policy simulation proved the effective result rather than relying on
  policy names: the Cotsel execution role can read its gateway runtime secret
  and cannot read the backend app secret; the backend execution role can read
  its app secret and cannot read the Cotsel secret; both application task roles
  are implicitly denied both secrets; both Terraform apply roles are explicitly
  denied `GetSecretValue`; and both plan-dispatch roles are implicitly denied.
- The migration execution role is separately scoped to the migration database
  secret. However, evidence task
  `81d9cc831a2b4d5296794c017910890e` proved that the existing
  `agroasys-staging-db-role-bootstrap:4` definition uses an execution role that
  cannot retrieve its configured bootstrap credential. Revision 4 was manually
  registered by the SSO administrator on 2026-08-20, has no tags, and is absent
  from the staging-runtime Terraform state. It requests the RDS master,
  migration, and application database credentials while the execution role is
  intentionally allowed to read only the migration credential. The task is
  non-runnable and is unmanaged drift; broadening the role would violate the
  established separation.

### Misconfiguration and privilege findings

- The Cotsel Terraform apply role has a wildcard-resource identity statement
  containing `secretsmanager:*`, `kms:*`, `logs:*`, `ecs:*`, `ecr:*`, `ec2:*`,
  and `elasticloadbalancing:*`. Its effective permissions are constrained by
  `agroasys-terraform-cotsel-staging-boundary`, including an explicit deny on
  secret reads, writes, and deletion and KMS-key disablement/deletion. The broad
  identity policy remains unnecessarily difficult to audit, but live
  simulation proved it cannot retrieve either the Cotsel or backend secret.
- The plan-dispatch role is correctly unable to call `GetSecretValue`; it can
  list/describe the resource containers and manage encrypted plan objects. The
  apply role should not need plaintext retrieval merely to create/reference
  secret ARNs.
- Repository Terraform intentionally creates secret containers only and has no
  `aws_secretsmanager_secret_version` resource. That design prevents values from
  entering Terraform state. The live Cotsel service, however, is manual drift:
  source Terraform still defines a single 512/1024 gateway task with four
  secret containers, while revision 13 runs six containers at 2048/4096 and
  references 16 secrets. A normal Terraform apply would regress the runtime and
  its IAM policy.
- Backend `bootstrap-secrets.sh` claims values never appear in command
  arguments, but it passes generated and merged secret documents through
  `node -e` arguments and passes the complete JSON document through AWS CLI
  `--secret-string`. That contradicts the program's explicit no-secret-command-
  argument requirement and can expose values through a local process listing.
  It requires a narrow remediation using stdin or an approved direct-entry
  mechanism before the script is used again.

### Secret container and Terraform-state evidence

- The Cotsel and backend secret containers are in `ap-south-1`, encrypted with
  customer-managed KMS keys. They have no regional replicas, no automatic
  rotation, and no per-secret resource policies. Automatic rotation is not
  enabled because neither protocol currently supports a proved overlapping-key
  rotation procedure.
- Settlement ingress is
  `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/gateway-settlement-ingress-mO4FwK`,
  with one `AWSCURRENT` version (`31afa1f6-d03c-4374-99b9-e20061725aa8`).
  Settlement callback is
  `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/gateway-settlement-callback-4ccaJW`,
  with one `AWSCURRENT` version (`c216efa4-8fb8-49ef-a9fe-5c2bbf7b641e`).
- A value-to-value comparison was performed entirely through pipes, emitting
  booleans and identifiers only. Both objects have the expected schema. The
  backend ingress value matches the gateway ingress value, the backend callback
  value matches the gateway callback value, and the two cryptographic secrets
  are different. The non-secret identifiers are
  `agroasys-backend-staging-v1` and `cotsel-gateway-staging-v1`.
- The managed RPC secrets and backend app-config secret each have one
  `AWSCURRENT` version. No secret value was printed during metadata inspection.
- Remote Terraform state for Cotsel and backend contains
  `aws_secretsmanager_secret` containers but no
  `aws_secretsmanager_secret_version` resource. Output metadata exposes ARNs and
  runtime inventory only; no output is marked sensitive and no secret value is
  managed by these roots. This proves these roots do not place secret values in
  Terraform state.
- All six active backend task definitions (`:5`) and Cotsel task definition
  `:13` were inspected. Sensitive configuration is represented by ECS
  `secrets.valueFrom`; no API credential, database password, HMAC secret,
  authenticated RPC URL, or signer key appears in plaintext `environment`.

### Leakage and signer-custody findings

- GitHub API inspection proved secret scanning is disabled on all three
  repositories: `Agroasys/Cotsel`, `Agroasys/agroasys-backend`, and
  `Agroasys/Cotsel-Dash`. Repository documentation requires secret scanning,
  but there is no active GitHub control to enforce it.
- Current-tree targeted scans found no raw 64-hex private-key assignment and no
  authenticated Infura/Alchemy endpoint in the three clean audit worktrees.
  A full-history Gitleaks 8.30.1 scan then covered 857 Cotsel commits, 847
  backend commits, and 242 Cotsel-Dash commits. Cotsel-Dash returned zero
  findings. Cotsel returned 18 generic-key findings: issue-route keys,
  idempotency fixtures, and the standard Hardhat test identity
  `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`; that test identity does not match
  any live AWS signer. Backend returned 19 generic-key findings, all in test
  idempotency/receipt fixtures or a historical test encryption value; the
  historical value is absent from the current tree and does not match a live
  app-config field. No detected finding is classified as a live credential.
- The three Base Sepolia private keys disclosed outside the approved secret
  store must be treated as compromised even though they control testnet-only
  identities. Their public addresses remain referenced in current Cotsel
  deployment evidence and Cotsel-Dash rehearsal runbooks. One address is used
  as candidate oracle, treasury, and relayer authority, while another is used
  in pilot evidence. The seven live AWS wallet secrets were derived to public
  addresses without printing key material; none matches any of the three
  disclosed identities. The AWS-held signer material is therefore not exposed
  by that disclosure, but stale evidence and any historical role assignments
  cannot support accepted deployment provenance.
- No exposed value is reproduced in this ledger. The audit will not reuse those
  private keys.

### Batch 5 conclusion

The active ECS secret-consumption and role model is VERIFIED, and the two
settlement directions are cryptographically distinct and correctly bound.
Batch 5 remains PARTIALLY VERIFIED because the manual database-role bootstrap
is non-runnable and outside IaC, `bootstrap-secrets.sh` violates the no-secret-
argument rule, repository secret scanning is disabled, and current operational
documents still contain compromised public identities as active-looking role
assignments. No role, policy, secret, KMS key, task definition, signer, or
repository setting was changed during this audit batch.

## Batch 6 — Service-to-service authentication audit

Status: **PARTIALLY VERIFIED**. Both live directions use compatible HMAC-SHA256
canonicalization and reject signature/body/timestamp/key tampering. Cotsel
ingress rejects malformed nonces, but the backend callback verifier accepts a
nonce longer than the gateway's 255-character limit. That asymmetry requires a
narrow remediation and regression test in Batch 18.

### Canonical protocol inspection

- Backend and Cotsel both sign six newline-delimited fields in this order:
  uppercase HTTP method, path, query without `?`, SHA-256 body hash, decimal
  Unix-seconds timestamp, and nonce. The signature is lowercase hexadecimal
  HMAC-SHA256. Both use constant-time byte comparison for correctly shaped
  signatures.
- The backend sender signs the exact URL pathname it sends. The Cotsel receiver
  derives path/query from Express `originalUrl`. Cotsel's callback sender strips
  a leading `?` before signing and the backend callback guard splits
  `originalUrl` into the same path/query representation.
- Cotsel validates the service-key JSON as either a singleton or array of
  `{id, secret, active}` and requires `active` to be a boolean. Inactive keys
  return 403. The configured backend-ingress key is active.
- The backend application is created with Nest `rawBody: true`, so callback body
  hashing uses the received bytes rather than reserialized JSON in the deployed
  path. Cotsel signs the same `JSON.stringify(payload)` bytes it sends.
- A direct cross-repository vector comparison emitted
  `canonicalCompatible=true`, `signatureCompatible=true`, and a 32-byte
  signature. It imported the current backend TypeScript utility and current
  Cotsel shared-auth implementation rather than duplicating their algorithms.

### Automated checks actually run

- Cotsel shared-auth: 3/3 tests passed (key parser, valid signed request, replay
  rejection).
- Backend targeted suites: 3 suites and 28 tests passed for the service-auth
  utility, Cotsel settlement client, and callback verifier.
- The existing suites do not cover every required negative case. In particular,
  backend callback tests omit unknown-key, timestamp-skew, tampered-body, and
  malformed-nonce cases; Cotsel shared-auth tests omit most negative branches.
  This is a test-coverage gap even though the live gateway behavior is stronger.

### Live AWS gateway ingress proof

Fresh signed requests were sent through
`https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1` using the current
Secrets Manager reference. No credential or auth header was printed.

| Case                                        | Live result                        | Request ID                             |
| ------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Valid signed GET `/settlement/capabilities` | HTTP 200, `success=true`           | `c537ef7c-f0e0-4ad8-8bd4-5c114862eb08` |
| Tampered signature                          | HTTP 401, `AUTH_INVALID_SIGNATURE` | `b33fe665-4d0e-4e89-b177-096d20cac16a` |
| Unknown API-key identifier                  | HTTP 401, `AUTH_UNKNOWN_API_KEY`   | `fe55767f-e185-4ab6-87b1-b2524a63164f` |
| Timestamp older than the 300-second window  | HTTP 401, `AUTH_TIMESTAMP_SKEW`    | `f5e08b21-2871-498f-a7fd-0120a6ceec42` |
| 256-character nonce                         | HTTP 401, `AUTH_INVALID_NONCE`     | `f441da7a-adc4-4d9c-91b2-834333867656` |
| Body changed after signing                  | HTTP 401, `AUTH_INVALID_SIGNATURE` | `93db9605-6eb6-4414-bf59-38804e17e231` |

CloudWatch structured access records place every request on stream
`ecs/gateway/80454c4efed24a418fd406491fd0489c`. ECS confirms that task is running
`cotsel-staging-gateway:13` and gateway image digest
`sha256:811e7a362985d7a9e1b6e17c9a5b23222cdfe8f96c41e13fc9df0478f2cc09c2`.
The HTTP responses therefore came from the current AWS staging revision, not a
stale GCP origin.

### Live AWS backend callback-boundary proof

Cotsel task definition `:13` targets the canonical direct URL
`https://api.staging.agroasys.com/api/v1/settlement-handoffs/cotsel/callbacks/execution-events`.
That hostname resolves to the deployed AWS CloudFront distribution whose sole
origin is the internal Mumbai backend ALB. The route is guarded before DTO
validation.

Using the current callback secret, a correctly signed empty object reached DTO
validation and returned HTTP 400; this proves authentication passed without
creating a callback record. Tampered signature and tampered body returned 401.
An unknown key returned the same generic 401 signature-verification message,
which avoids disclosing whether an identifier exists. An expired timestamp
returned 401. Reusing an already authenticated nonce returned 401 on the second
attempt. These are authentication-boundary probes, not a real callback-delivery
proof.

The malformed-nonce probe found a defect: a signed 256-character nonce also
reached DTO validation with HTTP 400. Backend code trims neither nor bounds the
nonce before composing its Redis key. This differs from Cotsel's maximum of 255
characters and leaves an avoidable unbounded-key/input surface. The fix must
reject empty/oversized nonces before signature/Redis consumption and add live-
equivalent regression coverage.

### Batch 6 conclusion

The protocol, credential mapping, raw-body handling, canonical path, live
gateway positive/negative behavior, and backend callback signature/replay
behavior are proven. Batch 6 is not fully VERIFIED because callback nonce-format
validation and complete negative-case test coverage are missing. No source,
credential, or runtime configuration was changed during this batch.

## Batch 7 — Persistent replay-protection audit

Status: **PARTIALLY VERIFIED**. Both deployed authentication directions use a
shared persistent data service and atomic first-use semantics. Fresh live
requests prove replay rejection at both boundaries. A controlled gateway
restart and deterministic cross-backend-task attribution have not yet been
performed, and neither direction has replay-specific metrics or alerting.

### Cotsel ingress store

- `gateway/src/server.ts` constructs `settlementNonceStore` with
  `createGatewayServiceAuthNonceStore(pool)` and passes that exact instance into
  the settlement router. Staging therefore does not instantiate the in-memory
  test nonce store.
- The implementation inserts `(api_key, nonce, expires_at)` into PostgreSQL
  with `ON CONFLICT (api_key, nonce) DO NOTHING`; the table primary key is the
  same two-column identity. Concurrent consumers therefore have database-
  enforced first-use-wins behavior rather than a read-then-write race.
- Expired rows are deleted before insertion, and a dedicated expiration index
  supports cleanup. The namespace contains the non-secret API-key identifier
  and nonce only; no credential secret is stored.
- RLS is enabled and forced on `service_auth_nonces`; its policy admits only a
  connection whose `current_app_service_name()` is `gateway`.
- Active task definition `cotsel-staging-gateway:13` configures max skew `300`
  seconds and nonce TTL `600` seconds and injects the gateway database password
  and ingress-key object through Secrets Manager references.
- A fresh signed GET to the live gateway returned HTTP 200. Repeating the exact
  same signed request, timestamp, and nonce returned HTTP 401 with
  `AUTH_NONCE_REPLAY`. No secret or reusable auth header was emitted.

### Backend callback store

- The callback verifier creates an `IORedis` connection from the canonical
  backend queue Redis URL and consumes nonce keys with Redis
  `SET key 1 EX <ttl> NX`. This is an atomic first-use operation shared by all
  API processes using that replication group.
- Store errors throw HTTP 503 rather than allowing the callback through, so the
  replay control fails closed. The targeted unit suite explicitly proves that
  behavior.
- Active service `agroasys-staging-api` runs two tasks on task definition `:5`.
  Both receive the same `rediss` primary endpoint. The endpoint matches
  replication group `agroasys-staging`, which is available, encrypted in
  transit and at rest, Multi-AZ, and automatic-failover enabled, with nodes in
  `ap-south-1a` and `ap-south-1b`.
- The active task definition configures max skew `300` seconds and nonce TTL
  `600` seconds. A fresh live signed callback-boundary probe reached DTO
  validation and the identical signed replay returned HTTP 401, proving the
  Redis gate is active in staging.

### Remaining proof and observability gaps

- Cotsel currently runs one gateway task. The PostgreSQL implementation and
  live rejection prove a persistent store is in the deployed code path, but a
  controlled restart-inside-TTL exercise has not yet been executed. Restarting
  staging during the audit-only phase would be an unnecessary mutation; the
  exercise belongs in the controlled post-remediation live proof.
- The backend ALB does not expose task identity in its callback response, so the
  replay pair cannot prove which of the two tasks served each attempt. The two
  tasks are configured to the same Redis endpoint, but deterministic cross-task
  routing or a restart exercise remains unproven.
- Cotsel does not pass an `onReplayReject` telemetry hook to the shared-auth
  middleware. The backend throws a typed HTTP exception but has no dedicated
  replay counter. Access responses can be observed, but no actionable replay-
  specific alarm currently exists.

### Batch 7 conclusion

Persistent/shared storage selection, atomic consumption, TTL configuration,
failure behavior, and live replay rejection are proven for both directions.
Batch 7 remains PARTIALLY VERIFIED until the controlled live-proof batch
demonstrates persistence across an actual restart or independently identified
tasks and until the remediation pass adds actionable replay visibility. No
runtime, cloud, or source configuration was changed during this batch.

## Batch 8 — Network and ingress audit

Status: **PARTIALLY VERIFIED**. The active AWS origins are private and cannot be
reached directly from the Internet, TLS is enforced at both public edges, and
ECS has stable two-AZ NAT egress. The Cotsel distribution lacks WAF protection,
its application rate limiter is disabled, and neither CloudFront nor ALB access
logging is enabled. Those gaps prevent a fully verified edge-control posture.

### Actual public traffic paths

- `cotsel.sys.agroasys.com` is a direct CNAME to CloudFront distribution
  `E2RCCBSGZN8VKE` (`d16q72wnefquce.cloudfront.net`). It is not proxied through
  Cloudflare. The authoritative DNS servers for `agroasys.com` are
  `ns1.yatosha.com` and `ns2.yatosha.com`.
- The Cotsel distribution uses CloudFront VPC Origin
  `vo_8sZ5lXQKqGVBJxaLdkZQnI`, bound to internal ALB
  `cotsel-staging-gateway`. The ALB has no public address and accepts HTTPS 443
  only from AWS-managed prefix list
  `com.amazonaws.global.cloudfront.origin-facing`. It forwards only to the
  gateway task security group on port 3600.
- `api.staging.agroasys.com` resolves to CloudFront distribution
  `E36EL5C7IP6HGV`. Its VPC Origin `vo_EmK5ou3eMUZC5pOOPFblSO` is bound to the
  internal `agroasys-staging` ALB. That ALB accepts HTTP 80 only from the same
  CloudFront origin-facing prefix list and forwards only to the API task group
  on port 3000.
- `backend.agroasys.com` still resolves to GCP address `34.172.10.248`. This is
  the legacy GCP backend path identified in Batches 3–4; it is not the callback
  destination used by active Cotsel revision 13.

### TLS, forwarding and bypass controls

- Both viewer certificates are ACM-managed and enforce minimum
  `TLSv1.2_2021`. Cotsel rejects plain-HTTP viewers; backend redirects them to
  HTTPS.
- Cotsel also uses HTTPS from CloudFront VPC Origin to the internal ALB with
  `ELBSecurityPolicy-TLS13-1-2-2021-06`. Backend's private CloudFront-to-ALB hop
  is HTTP inside the VPC; the public viewer hop remains TLS.
- Cotsel's no-cache policy has zero minimum/default/maximum TTL. Its origin
  request policy forwards the HMAC, nonce, request ID, idempotency and content-
  type headers plus all query strings, but no cookies. Backend uses AWS's
  no-cache policy and forwards viewer headers except Host, all query strings,
  and cookies.
- Direct origin bypass is prevented by the internal ALB scheme plus
  CloudFront-prefix-list-only ingress. The default CloudFront hostname can
  reach Cotsel health, but this is the same CloudFront edge and VPC Origin, not
  an origin bypass.
- Both ALBs drop invalid HTTP headers and use defensive desynchronization
  mitigation. Cotsel ALB deletion protection is enabled; backend ALB deletion
  protection is disabled.

### ECS placement and egress

- Cotsel gateway task `80454c4efed24a418fd406491fd0489c` runs in private
  subnet `subnet-02b28a68bfc9c12b9` without a public IP. The two backend API
  tasks run one per private subnet/AZ, also without public IPs.
- Application ingress security groups admit only their respective ALB security
  group and port. The shared data-client group permits only PostgreSQL 5432 and
  Redis 6379 to the corresponding data security groups. Application Internet
  egress is restricted to TCP 443, although destination CIDR remains
  `0.0.0.0/0` for approved external providers.
- Each private subnet has its own available NAT gateway and Elastic IP, so
  outbound restrictions can safely account for two stable staging egress
  addresses rather than assuming one. The VPC also has an S3 gateway endpoint.
  No interface endpoints for Secrets Manager, CloudWatch Logs, SQS, or ECR are
  present; those paths use NAT.
- VPC flow logs are active for all traffic to CloudWatch log group
  `/aws/vpc/agroasys-staging`. The default network ACL allows all traffic, so
  security groups are the effective fine-grained network boundary.

### Edge protection and logging gaps

- Backend CloudFront has AWS WAF `agroasys-staging-edge`. Its four AWS managed
  rule groups are currently in **count** mode, not blocking mode; only the
  2,000-requests-per-five-minutes IP rate rule blocks. WAF logs are delivered
  to `aws-waf-logs-agroasys-staging` with Authorization and Cookie redacted.
- Cotsel CloudFront has no Web ACL. Active gateway task configuration also sets
  `GATEWAY_RATE_LIMIT_ENABLED=false`. The public Cotsel surface therefore has
  neither an edge rate/WAF control nor the repository's application limiter.
  HMAC still protects settlement ingress, but that does not replace denial-of-
  service and generic bad-input controls for the public endpoint.
- Standard and real-time CloudFront access logging are disabled on both
  distributions. ALB S3 access logging is also disabled on both ALBs. App
  access logs and VPC flow logs exist, but cannot reproduce all viewer/edge and
  load-balancer decisions.
- No CloudWatch alarm with a Cotsel or edge-WAF prefix exists. This finding is
  carried into the dedicated observability batch rather than treated as a
  network-only fix.

### Batch 8 conclusion

Private-origin enforcement, task isolation, active target health, viewer TLS,
HMAC header forwarding, stable NAT egress and VPC flow logging are VERIFIED.
Batch 8 is only PARTIALLY VERIFIED because Cotsel lacks WAF/rate limiting, edge
and ALB access records are absent, backend WAF managed protections only count,
and the legacy GCP backend hostname remains live. No DNS, WAF, CloudFront, ALB,
security-group, route, task, or GCP resource was changed during this audit
batch.

## Batch 9 — ECS runtime audit

Status: **PARTIALLY VERIFIED**. The active AWS tasks and targets are healthy and
their exact image digests are known, but the Cotsel runtime is manually
assembled drift, has single-task/coupled-service failure domains, disables
database certificate verification in four containers, omits health checks for
two essential containers, and runs images with unresolved critical/high OS
vulnerabilities. Treasury and Ricardian remain GCP-only.

### Active Cotsel runtime

- ECS service `cotsel-staging-gateway` is steady on task definition
  `cotsel-staging-gateway:13`, desired/running `1/1`, task
  `80454c4efed24a418fd406491fd0489c`. The ALB target is healthy.
- Revision 13 is a 2-vCPU/4-GiB Fargate task containing six essential
  containers: gateway, auth, indexer pipeline, indexer GraphQL, oracle, and
  reconciliation. Its active digests were independently matched against ECR.
- Gateway, auth, indexer GraphQL, oracle and reconciliation all emitted current
  CloudWatch events; the indexer pipeline was also actively advancing. A scan
  of the latest 500 events per current stream found no error/fatal/exception-
  like event. Log groups use 30-day retention and the Cotsel KMS key, except the
  unused/manual db-bootstrap log group, which is not KMS-encrypted.
- Auth, indexer GraphQL, oracle and reconciliation have ECS container health
  checks and report healthy. Gateway relies only on its ALB health check and
  reports ECS container health `UNKNOWN`; indexer pipeline has no container
  health check and also reports `UNKNOWN`. A hung pipeline can therefore remain
  running without an ECS health failure.
- All six containers are essential and share one task ENI and one task resource
  envelope. Any essential-container exit restarts the complete bundle. The
  service has desired count 1, no autoscaling, `minimumHealthyPercent=0`, and no
  deployment circuit breaker/automatic rollback. A deployment or single task
  loss can therefore interrupt every AWS Cotsel component simultaneously.
- Revision 13 was registered manually by the SSO administrator. Current
  Terraform still defines the smaller gateway-only revision and would regress
  this runtime. No normal apply is safe until IaC owns the six-container
  topology.

### Runtime security and configuration findings

- Auth, indexer pipeline, indexer GraphQL, oracle and reconciliation set
  `NODE_TLS_REJECT_UNAUTHORIZED=0` and/or PostgreSQL `no-verify`; gateway uses
  `DB_SSL_MODE=require`, which encrypts but does not establish the same CA-
  verified posture required by the program. The active database path is
  encrypted but server identity is not consistently verified.
- Gateway/auth/oracle application rate limiting is disabled. The Cotsel edge
  also lacks WAF as recorded in Batch 8.
- Oracle explicitly uses `raw_private_key` custody from an ECS secret. This is
  the current implemented signer path, not a hardware/managed human-governed
  deployment authority.
- Gateway mutations and gasless execution are disabled, while settlement
  ingress, callback delivery and reconciliation are enabled. Chain ID, USDC,
  escrow address and indexer start block are explicit in revision 13; their
  correctness is audited in later Base/contract convergence batches.
- Gateway, auth, oracle and reconciliation images run as a non-root image user.
  The indexer Dockerfile defines no `USER`, so both deployed indexer containers
  run as root. No Cotsel container uses a read-only root filesystem.
- ECS Exec is disabled, which reduces interactive production access. Sensitive
  values are injected from Secrets Manager and were not printed in this audit.

### Image provenance and vulnerability evidence

- ECR repositories are KMS-encrypted, immutable-tag repositories with scan-on-
  push enabled. Gateway and both indexer images are tagged with full source
  commit `21a39773cbcc518b36e7bd78c408bd4c573cd46f`, which is an ancestor of
  current `origin/main`. Running tasks resolve those immutable tags to recorded
  digests.
- Oracle tag `47016df66306` resolves to GitHub commit
  `47016df66306305d3cbd2f1bcbd4320c14a18d28`; auth and reconciliation tag
  `1049672` resolves to commit
  `104967286d8fbf83bff9cdb24aea62f7dcf80286`. GitHub can retrieve both commits,
  but neither is an ancestor of current main, a branch head, or associated with
  a PR. The images are reproducible by object ID today, but these commits are
  not accepted branch truth and cannot support durable release provenance.
- ECR basic scans were resolved at the architecture-manifest level for the
  newer OCI image indexes. Gateway and reconciliation each contain 1 critical
  and 8 high OS findings. Auth and oracle each contain 5 critical and 18 high;
  both indexer images contain 5 critical and 19 high.
- Gateway/reconciliation findings are OpenSSL 3.5.6-r0. Alpine's official
  tracker records 3.5.7-r0 as fixed for the critical CMS issue. Repository
  inspection found no CMS processing path, so direct application reachability
  is not currently proven; the affected runtime layer still requires rebuild.
- Debian-image findings include GnuTLS 3.7.9-2+deb12u6, Perl, expat, dpkg,
  OpenSSL and libcap. Debian officially fixes the identified GnuTLS flaws in
  `3.7.9-2+deb12u7`. One critical Perl/Storable issue remains unfixed in
  Bookworm. The runtime Docker stages unnecessarily install Python, make and
  g++, pulling Perl/GnuTLS and other build-only packages into the deployed
  image even though production `pnpm install` runs with `--ignore-scripts`.
  Removing build tooling from runtime and rebuilding from patched bases is the
  narrow remediation; an npm override cannot fix these OS findings.
- The backend image digest used by all six Agroasys ECS lanes has a completed
  ECR scan with zero findings.

### Agroasys backend runtime relevant to Cotsel

- Backend API runs two healthy tasks across the two private AZs. The settlement,
  critical-job, payments, compliance and notification workers each run one
  task. All six services are on task definition revision 5 with completed
  rollout, circuit breaker and rollback enabled, no public IP, and CPU target-
  tracking autoscaling (`2–6` for API, `1–3` for workers).
- All backend task definitions pin the same exact ECR digest rather than a
  mutable tag. API has a container health check; worker task definitions have
  none, so worker liveness depends on process exit and external metrics/alarms.
- These task definitions were also registered by the SSO administrator, but
  unlike Cotsel their deployed shape matches the runtime model represented by
  backend Terraform closely enough for the later drift/remediation review.

### GCP residual runtime

- GCP VM `cotsel-staging` is still running a separate healthy Compose stack:
  gateway, auth, oracle, **treasury**, reconciliation, indexer GraphQL, indexer
  pipeline, **Ricardian**, PostgreSQL and Redis.
- AWS revision 13 has no treasury or Ricardian container. Those capabilities
  therefore have no live AWS runtime replacement and remain GCP-only rather
  than migrated. Existing empty AWS log groups for treasury/Ricardian are not
  runtime evidence.

### Batch 9 conclusion

The exact active revisions, digests, task placement, target health, configuration
surfaces and GCP residual services are now known. Batch 9 is not VERIFIED due to
critical/high image findings, incomplete provenance, TLS verification disablement,
root-running indexers, missing health/rollback/scaling controls, Terraform
drift and absent AWS treasury/Ricardian workloads. The ECR scan lookup was the
only cloud-side evidence action; no image, task, service, database, traffic or
source configuration was changed.

## Batch 10 — Durable data, queues and event correctness

Status: **PARTIALLY VERIFIED**. The backend's critical settlement dispatch and
reconciliation handoffs use a transactional PostgreSQL outbox followed by
encrypted FIFO SQS queues with DLQs. Cotsel creates settlement events and
callback-delivery records in one PostgreSQL transaction. The deployed queue
configuration is real and the repository tests pass, but current-revision live
traffic has not exercised the AWS SQS path, alarms notify nobody, and Cotsel can
permanently strand a callback in `delivering` after a process failure.

### Backend durability boundary

- Settlement dispatch and reconciliation-sync jobs are inserted into
  `outbox_messages` inside the same Prisma transaction as the business-state
  transition. Each record requires an idempotency key and the database enforces
  uniqueness on `(jobName, idempotencyKey)`.
- The outbox publisher claims rows atomically with `FOR UPDATE SKIP LOCKED`, a
  30-second lease and incremented attempt count. A failed publish is deferred
  with bounded backoff and is quarantined with an audit record after five
  attempts. An expired claim becomes eligible again, so a worker death does not
  permanently strand a pending outbox row.
- Critical jobs route to SQS in staging. Non-critical notification fanout still
  uses BullMQ/Redis, but the callback transaction itself is committed before
  that fanout. If Redis enqueue fails, notification fanout runs synchronously;
  Redis is not the source of settlement state.
- The public Cotsel callback handler verifies HMAC before DTO processing, then
  persists the execution event and handoff projection transactionally. A unique
  `sourceEventId` prevents a second authoritative event row. Reconciliation
  callbacks additionally require chain evidence before the transaction commits.
  The follow-on reconciliation job is written to the outbox in that transaction.
- The HTTP handler deliberately performs the authoritative database transition
  in the request thread rather than acknowledging before persistence. This is a
  safe synchronous boundary, but concurrent fresh-signature deliveries of the
  same source event can still race between the pre-insert lookup and the unique
  insert. One request may receive a database conflict instead of the existing
  idempotent result; Cotsel will retry, but deterministic duplicate acceptance is
  not fully proven.

### Live SQS configuration and worker behavior

- The active critical worker is service
  `agroasys-staging-critical-job-worker`, task definition revision 5,
  desired/running `1/1`. It explicitly runs with
  `JOBBUS_CRITICAL_TRANSPORT=sqs` and polls the compliance-callback,
  settlement-callback and reconciliation queues. Its task role is the only
  backend lane with queue receive/delete/send permissions.
- All three primary queues and their three DLQs are FIFO, SQS-managed encrypted,
  deny insecure transport, retain messages for 14 days and disable content-based
  deduplication. Primary queues use 20-second long polling, 300-second visibility
  and redrive to their dedicated DLQ after five receives. Each DLQ accepts
  redrive only from its corresponding source queue.
- Queue depth and in-flight counts were zero at inspection. CloudWatch reported
  zero sent, received and deleted messages for all three primary queues over the
  preceding seven days. This proves that the current SQS lane is idle, not that
  current-revision publish/consume/redrive works live.
- Every queue has an age alarm and every DLQ has a non-empty alarm. All six
  alarms are `OK`, but every `AlarmActions` list is empty and the account has no
  SNS topic in `ap-south-1`. These alarms cannot notify an operator and are not
  an operational control yet.
- `SqsJobWorkerService` deletes a message after `dispatch()` returns. The
  unsupported-job branch only logs a warning and returns, so an unknown critical
  job name is permanently deleted instead of retried or dead-lettered. Malformed
  JSON and handler exceptions do remain undeleted and are redriven by SQS. The
  unsupported-job behavior is a verified loss-of-evidence defect requiring a
  fail-closed fix.
- The worker does not extend message visibility while processing. The 300-second
  visibility timeout is plausible for current handlers, but no runtime upper
  bound or heartbeat proves that a slow provider/reconciliation call cannot be
  delivered twice. Consumer idempotency remains mandatory even with FIFO SQS,
  whose deduplication window is not a permanent exactly-once guarantee.

### Cotsel callback persistence and retry behavior

- `SettlementService.recordExecutionEvent()` derives a stable SHA-256 dedupe key
  from handoff, event type and request ID. The PostgreSQL store locks the handoff
  and atomically writes the execution event, handoff projection and callback
  delivery. A partial database commit therefore cannot create an event without
  its callback-delivery record.
- The callback dispatcher polls PostgreSQL every five seconds, claims each row
  with a conditional `UPDATE ... WHERE status IN ('pending','failed')`, signs a
  fresh HMAC request, applies a five-second request timeout and uses bounded
  exponential backoff. Current defaults allow eight attempts, beginning at two
  seconds and capped at 60 seconds. Terminal failures are mirrored into the
  gateway failed-operation ledger and require operator redrive.
- The conditional update safely prevents two replicas from claiming the same
  delivery simultaneously. However, the claim changes status to `delivering`
  without a lease expiry, and due-delivery selection includes only `pending` and
  `failed`. A task crash after the claim but before delivered/failed persistence
  leaves the row permanently invisible to polling and redrive. This is a
  correctness defect, not a monitoring-only gap.
- All non-2xx responses currently consume the same retry budget. Historical live
  logs show one delivery accepted with HTTP 201 and two other deliveries retrying
  HTTP 400/401 through the eighth attempt into dead letter. The bounded retry and
  dead-letter behavior is therefore real, but repeatedly retrying deterministic
  4xx responses should be reviewed and classified rather than treated like a
  transient transport outage.
- Those live callback records are from August 21 task streams, not the currently
  running revision-13 task. They are retained as historical operational evidence
  only; Batch 20 must create fresh evidence from the remediated current revision.

### Validation performed

- Queried all live SQS queue attributes, queue depths, redrive policies and
  seven-day sent/received/deleted metrics in AWS account `655177116834`, region
  `ap-south-1`.
- Queried EventBridge buses/rules: only the default bus exists and it has no
  rules. This matches deployed `INTERNAL_EVENTS_TRANSPORT=log`; the repository
  must not describe EventBridge as an active staging delivery lane.
- Queried the active critical-worker service and rendered task definition.
- Queried all SQS CloudWatch alarms and SNS topics, proving alarm actions are
  empty.
- Ran backend targeted outbox/job-bus/settlement tests after generating the
  local Prisma client: 7 suites, 98 tests, all passed.
- Ran Cotsel gateway callback dispatcher, idempotency and service-orchestrator
  tests: 3 suites, 21 tests, all passed.
- Queried redacted CloudWatch callback fields only. No callback body, HMAC
  header, queue payload or secret value was retrieved or recorded.

### Batch 10 conclusion

The intended durable architecture is substantially implemented and the active
AWS queues match IaC. Batch 10 cannot be VERIFIED until the unsupported-job
delete path and Cotsel's orphaned-`delivering` failure mode are remediated,
actionable alarm routing exists, and current-revision live publish/consume,
retry, DLQ/redrive and callback evidence is collected. No queue message,
database row, task, alarm, SNS resource, or source implementation was changed in
this audit batch.

## Batch 11 — Base Sepolia RPC configuration audit

Status: **PARTIALLY VERIFIED; CRITICAL CREDENTIAL ROTATION IN PROGRESS**. Both
managed providers independently returned Base Sepolia chain ID `0x14a34`, an
advancing/current block and the same deployed runtime bytecode for the evidenced
contract. ECS revision 14 injects the two Secrets Manager references into the
actual chain consumers. Real indexer startup selected the fallback after the
primary failed. A follow-up correction now rejects wrong-chain and unavailable
endpoints at startup, but it is not deployed yet. Runtime failover remains
incomplete, and an authenticated primary RPC URL was found in historical
CloudWatch error records.

### Provider and secret truth

- The primary is Infura and is stored at
  `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/rpc-base-sepolia-primary-XjIaRV`.
- The independent fallback is Alchemy and is stored at
  `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/rpc-base-sepolia-fallback-pG6ZlE`.
- Both are environment-local Secrets Manager objects tagged for staging, WP-7,
  the Cotsel production-readiness programme and Terraform ownership. Neither
  authenticated endpoint is present in ECS plaintext environment values.
- A secret-safe direct probe retrieved each endpoint through stdin and emitted
  only provider hostname and results. Both returned `0x14a34`. The fallback's
  observed block moved from `45833151` to `45833153` during the probe. Both
  providers returned `24,417` bytes of code for
  `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`.
- Infura returned HTTP 429 for one sequence of individual calls but later
  returned chain, block and code successfully as one JSON-RPC batch. The 429 is
  a real transient/provider-capacity behavior which runtime failover must handle,
  not evidence of a wrong chain.

### Actual RPC consumers

| Runtime          | Direct RPC purpose                                                     | Active configuration                                 | Current failover behavior                         | Audit result                                                |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| gateway          | Governance/runtime reads and disabled-by-config gasless execution path | Primary plus fallback secret; chain `84532`          | Ethers `FallbackProvider`, quorum 1               | Providers configured; no explicit fallback metric/event     |
| oracle           | Contract reads and managed-signer writes                               | Primary plus fallback secret; chain `84532`          | Ethers `FallbackProvider`, quorum 1               | Providers configured; live write/fallback not yet exercised |
| reconciliation   | Contract reads used to compare indexed and chain facts                 | Primary plus fallback secret; chain `84532`          | SDK/Ethers `FallbackProvider`, quorum 1           | Providers configured; current data set is empty             |
| indexer pipeline | Block/log ingestion for the accepted escrow deployment                 | Primary plus fallback secret; start block `45807259` | Selects one reachable endpoint at process startup | Startup rotation works; no runtime provider switch          |
| indexer GraphQL  | Serves indexed PostgreSQL state                                        | No direct RPC                                        | Not applicable                                    | Correctly has no RPC secret                                 |
| auth             | Authentication API                                                     | No direct RPC                                        | Not applicable                                    | Correctly has no RPC secret                                 |
| Agroasys backend | Uses the signed Cotsel boundary rather than chain access               | No active direct RPC configuration                   | Not applicable                                    | Correct separation in current ECS API revision              |
| treasury         | Would require read/write RPC                                           | No AWS workload exists                               | Not applicable                                    | GCP-only residual; migration gap remains                    |

### Failover and fail-closed findings

- Shared startup reachability calls `eth_chainId` but checks only that a result
  exists; it never compares the returned chain with expected `84532`. The
  indexer duplicates this behavior. A responsive wrong-chain endpoint can pass
  startup selection.
- The indexer selector returns the primary even when no endpoint responds. This
  is explicitly fail-open and contradicts the programme requirement to reject
  an unavailable or wrong-network RPC at startup/readiness.
- Ethers consumers receive configured chain ID and perform stronger network
  checks on actual use, but the lightweight process startup probe is not a
  substitute for the SDK's contract runtime preflight, which checks network,
  code, USDC and roles.
- The indexer can rotate only during startup. Once Subsquid has selected an
  endpoint, later 429, transport or provider failures are retried against that
  same endpoint. It does not switch to the configured fallback without a
  restart.
- The latest inspected indexer stream selected Alchemy with `checked: 2`, proving
  real ECS startup rotation after the Infura probe failed. Earlier streams show
  Infura 429 and provider errors followed by task restarts; this is not runtime
  failover and is operationally disruptive.
- There is no CloudWatch alarm or application metric for primary failure,
  fallback activation, both providers unavailable, wrong chain or stale block.

### Critical RPC credential exposure and containment

- Subsquid's RPC client strips URL user-info credentials but retains provider
  keys embedded in a URL path. On RPC errors, its structured record included the
  full authenticated Infura URL in `rpcUrl`, error reason and nested response
  fields. Historical records in the KMS-encrypted, 30-day-retained indexer log
  group therefore contain a usable credential.
- The exposed value is not reproduced in this ledger. Rotation is mandatory;
  deleting the logs would destroy audit evidence without revoking the key.
- A narrow indexer root-sink sanitizer was merged through PR `#714` at merge
  commit `17269f8e95018b806a82f0cc75ae2eed034c3a01`. It
  replaces every
  configured primary/fallback endpoint with its origin plus `[redacted]`
  recursively, including nested error objects and stacks, while preserving
  method, block, error class and other operational fields.
- New regression tests prove configured tokens and query credentials are absent
  from nested serialized records and from the installed root sink's actual
  stderr output. Indexer typecheck, lint, build and all 28 runnable tests pass;
  two pre-existing database migration tests remain skipped. All hosted PR checks,
  including DCO, CodeQL, release gates and release-image jobs, passed at the
  merged head. Release Images run `32624904509` and CI Release Gate run
  `32624904637` both succeeded for the exact merge commit.
- A replacement Alchemy app named
  `Agroasys Cotsel - Base Sepolia Fallback v2` was created with Base enabled and
  only the Node API active. The new endpoint independently returned chain ID
  `0x14a34`; consecutive block reads advanced from `45835267` to `45835268`.
- The replacement endpoint was written to the existing fallback Secrets Manager
  object through process stdin, not command arguments or Terraform state. AWS
  created version `9b95d75d-cfd7-4dae-9cdc-891b34d0089b` as `AWSCURRENT`. A
  fresh read through Secrets Manager returned `0x14a34` and block `45835288`,
  and matched the just-created endpoint without printing it.
- The replacement Alchemy app now allows only the two Cotsel staging NAT egress
  addresses. An isolated Fargate probe ran in the same private subnets and
  security groups as the service. It exited `0`, returned chain ID `0x14a34`,
  and observed blocks advance from `45850896` to `45850898`. The probe emitted
  no endpoint or credential.
- ECS revision `cotsel-staging-gateway:14` pins the indexer images to the exact
  release digests for merge commit `17269f8e95018b806a82f0cc75ae2eed034c3a01`.
  Running task `a6829b7869444015829fb60492724d47` is healthy, its ALB target is
  healthy, and the public gateway health endpoint returns HTTP `200`. Fresh
  indexer logs show advancing Base Sepolia heads and redact authenticated RPC
  paths.
- The ECS deployment controller now uses `minimumHealthyPercent=0` and
  `maximumPercent=100`. This prevents two Subsquid processors from updating the
  same status table during a single-task deployment. This manual runtime change
  must be reconciled into IaC before the audit can accept drift remediation.
- The original Alchemy app remains active as rollback material. The Infura free
  plan permits one API key and offers
  no in-place regeneration; safe primary rotation therefore requires a
  controlled Alchemy-backed cutover followed by explicit approval to permanently
  delete and recreate the exposed Infura key.
- The issue remains an active blocker until the old Alchemy credential is
  revoked, Infura is rotated, the wrong-chain correction is merged and deployed,
  and a controlled outage/recovery exercise proves the final runtime behavior.

### Wrong-chain remediation merged; deployment withheld

- The shared SDK startup probe now accepts an expected chain ID and rejects a
  responsive endpoint on another chain. Gateway, oracle, reconciliation and
  treasury pass their configured chain ID into that probe.
- The indexer now requires `CHAIN_ID`, selects only an endpoint that returns the
  configured chain, and fails closed when no endpoint passes. It emits
  `rpc.primary_selected` or `rpc.fallback_selected` without credential-bearing
  URL paths.
- New SDK tests prove correct-chain acceptance, wrong-chain rejection with URL
  redaction, and correct-chain fallback after a wrong-chain primary. New indexer
  tests prove fallback selection and fail-closed behavior.
- Repository-wide typecheck, lint and formatting pass. SDK tests pass `3/3`.
  Indexer tests pass `30/30` runnable tests; the same two database migration
  tests remain skipped because no migration test database is configured.
- PR `#717` was squash-merged as
  `b8050e1c086d0349db15c2e758728ebb4bceffc5`. CI Release Gate and CodeQL
  passed for that exact merge commit. The PR required independent review and
  had no submitted review; its admin merge is repository integration only, not
  independent release acceptance.
- Live revision 14 still uses the pre-remediation startup selector. Promotion
  of the merged image set was withheld after the release-image audit below
  proved that the image vulnerability job was fail-open.

### Release-image security gate finding and remediation

- The Release Images workflow scanned final images for HIGH and CRITICAL
  vulnerabilities with Trivy but set `exit-code: '0'`. A green image job
  therefore proved that a report was produced, not that the image met the
  vulnerability threshold.
- The gateway scan artifact for merge commit `b8050e1...` contains 43
  HIGH/CRITICAL findings, including one CRITICAL finding. The vulnerable paths
  are predominantly npm and Corepack/pnpm caches that are unnecessary at
  runtime; Alpine runtime packages also require the available OpenSSL update.
  Identifiers and counts are recorded here without reproducing provider
  credentials or other secret material.
- No image from `b8050e1...` was promoted to ECS after this finding. The current
  remediation removes package managers, package-manager caches and compiler
  toolchains from final runtime images, upgrades Alpine security packages,
  applies available Debian security updates, updates the pinned pnpm build tool
  to `10.34.4`, retains a complete HIGH/CRITICAL evidence report, and adds a
  second Trivy gate that returns non-zero for every HIGH/CRITICAL finding with
  an available fix. Unfixed vendor findings remain visible in the complete
  report rather than being misrepresented as remediated.
- Local final-image verification used Trivy `0.68.2`. The rebuilt auth runtime
  uses Node `20.20.2`, loads its production dependencies, contains none of npm,
  Corepack, pnpm, Python, Make or g++, and has zero HIGH/CRITICAL findings that
  Trivy classifies as fixable. Its complete report retains 30 Debian findings:
  26 HIGH and four CRITICAL, all classified as `affected`, `fix_deferred` or
  `will_not_fix` rather than fixed. A previously rebuilt gateway runtime had
  zero HIGH/CRITICAL findings after the substantive cleanup. A repeat gateway
  build after the final explicit Yarn-directory removal was interrupted first
  by a local Colima transport EOF and then by a stalled Alpine package download;
  that incomplete repeat is not counted as passing evidence.
- This finding is **MISCONFIGURED** until every release image is rebuilt and the
  corrected hosted scan passes. Dockerfile text or a successful application
  unit test alone does not close it.

### Release gate passed; first immutable promotion failed and rolled back

- PR [#718](https://github.com/Agroasys/Cotsel/pull/718) merged the fail-closed
  image gate and runtime hardening as
  `0ccc11dc7954c28e8a977d46b08f6ebec904af11`. No independent review was
  submitted; the administrator merge is integration evidence, not independent
  release acceptance.
- Main Release Images run
  [`32632281872`](https://github.com/Agroasys/Cotsel/actions/runs/32632281872)
  published all eight service images from that exact commit. Every image had
  zero HIGH/CRITICAL findings with an available fix. The complete reports for
  Debian-based services retain the visible vendor-unfixed findings described
  above.
- ECR tag and manifest inspection matched each published evidence artifact to
  its repository digest before promotion. Task definition revision `:15`
  pinned the six active containers to those exact digests, set the gateway
  build identity to `0ccc11d...`, and added the required indexer chain ID.
- The first revision `:15` task
  `f244d2da11b04faabdd89950f22be217` pulled all six intended digests but exited.
  Redacted CloudWatch startup evidence proved two independent runtime-contract
  defects: auth, oracle and reconciliation ignored `DB_SSL_MODE` and attempted
  unencrypted PostgreSQL connections; the indexer GraphQL task override invoked
  `pnpm`, which the hardened image intentionally removes.
- Revision `:14` was restored immediately. ECS reached `1/1/0`, target
  `10.40.136.126:3600` returned `healthy`, and
  `GET https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1/healthz`
  returned HTTP `200` at `2026-08-23T10:14:51.957Z`.
- PR [#719](https://github.com/Agroasys/Cotsel/pull/719) now carries the forward
  repair. It validates a single Postgres SSL mode contract for every shared
  runtime/migration pool, applies it to reconciliation reporting and treasury's
  reconciliation reader, and starts GraphQL through the package's direct Node
  entrypoint. Invalid legacy values fail closed. Repository-wide typecheck,
  lint, changed-file formatting and dependency security gates pass; focused
  configuration/database tests pass. The local protocol-health report remains
  red for the pre-existing missing chain/address inputs and incomplete
  historical deployment provenance, which this repair does not conceal.
- Revision `:15` is failed deployment evidence only. It is not accepted staging
  runtime truth. A new release digest set and a new task-definition revision
  must pass task, target-health, startup-log and public-health verification
  before promotion can be considered successful.

### Contract-address correction during the audit

An intermediate audit note transcribed the ECS address as `0xB594B33e...`, which
has no code. A raw task-definition re-query proved this was an audit
transcription error, not runtime split-brain. Gateway, indexer pipeline, oracle
and reconciliation all actually use the evidenced code-bearing
`0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`. The deployment transaction receipt
is successful, names that address and records block `45807259`. This establishes
address convergence and deployment existence only; Batch 12 must still prove
source/artifact provenance and independent acceptance.

### Batch 11 conclusion

Provider independence, secret references, Base Sepolia identity, current block
access, contract reads, address convergence, the restricted Alchemy AWS egress
path and deployed log containment are VERIFIED. Real startup rotation is also
VERIFIED. Batch 11 remains incomplete because the corrected images have not yet
passed the now-fail-closed security gate or been deployed, final credential
revocation is pending, the indexer lacks runtime provider switching, fallback
activation is not alarmed and no controlled post-remediation outage/recovery
exercise exists.

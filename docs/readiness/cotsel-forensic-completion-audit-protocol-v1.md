# Cotsel forensic completion audit protocol v1

## Status and execution boundary

Status: deferred final-acceptance protocol.

Programme gate: [#751](https://github.com/Agroasys/Cotsel/issues/751).

Apply this protocol to one frozen Base Sepolia staging candidate. Do not run it as
a parallel implementation programme ahead of the work packages.

- WP-0 through WP-8 implement and accept their owned controls.
- Baseline inspection may run earlier. Route each finding to its owning work package.
- Batch 20 is the WP-9 live cross-repository rehearsal.
- Batches 22 through 24 are the WP-10 independent acceptance pass.
- Assess GCP retirement readiness after WP-9. Delete only after WP-10 acceptance
  and explicit approval.
- A merge, green workflow, resource, secret, healthy task, chain transaction,
  explorer page, or migration document is not sufficient evidence by itself.

This protocol preserves the controls used by the dated execution record in
`cotsel-forensic-completion-audit-2026-08-22.md`. A later run must collect fresh
evidence for the frozen candidate.

## Objective

Independently prove repository, cloud, runtime, migration, identity, settlement,
chain, and operational truth. Find and safely remediate material gaps. Optimize
for correctness, least privilege, reproducibility, operational clarity, and
evidence, not for file count or issue closure.

## Governing rules

Read the repository agent instructions, engineering guidance, architecture,
runbooks, environment schemas, IaC, workflows, security material, Base deployment
material, settlement integration material, and relevant issue and PR history.

Use only these finding classifications:

- `VERIFIED`: directly proved by current code, cloud, runtime, or live evidence.
- `PARTIALLY VERIFIED`: some required conditions are proved; at least one is not.
- `NOT IMPLEMENTED`: the required implementation or resource does not exist.
- `MISCONFIGURED`: it exists, but the active configuration is wrong.
- `STALE / LEGACY`: an old path can conflict with or confuse the intended lane.
- `BLOCKED`: exact access, approval, credential entry, or decision is missing.

Use only these GCP dispositions:

- `MIGRATED`
- `INTENTIONALLY RETAINED`
- `READY TO DECOMMISSION`
- `BLOCKED / UNKNOWN`

Never promote probability, absence of errors, or inability to inspect into proof.

## Evidence ledger and invalidation

Maintain one redacted ledger. Bind applicable evidence to:

- repository and source commit;
- immutable image digest and producing workflow run;
- deployment workflow, Terraform root, plan artifact, apply run, state lineage,
  serial, and version;
- AWS account, region, ECS cluster, service, task definition, and running task;
- secret identifier and version stage without its value;
- database endpoint identifier and schema or migration identity;
- chain ID, contract address, deployment transaction, and deployment block;
- RPC provider identity without authenticated URLs;
- DNS record, CDN, load balancer, and origin;
- test time, trace ID, transaction hash, queue identity, CloudWatch query, and
  alarm-delivery evidence; and
- GCP project, resource, snapshot, consumer, and disposition.

A change invalidates the evidence for every surface it materially affects. It
does not invalidate unrelated evidence. The final second pass rechecks the full
critical path even when individual records remain current.

Never record secret values, private keys, seed phrases, authenticated RPC URLs,
cookies, bearer tokens, Terraform state, or unredacted customer information.

## Separation of duties

For security-sensitive and settlement-sensitive changes:

- the author cannot provide final acceptance;
- the plan reviewer cannot be the sole applier and acceptance authority;
- the deployer cannot accept their own deployment evidence;
- review state, review commit, unresolved threads, applied commit, and deployed
  commit must be recorded; and
- contract acceptance, IAM, production-like DNS, wallet custody, secret rotation,
  and GCP decommission require explicit counterpart approval.

Administrative merge authority does not waive the acceptance control.

## Working-tree and change discipline

Use clean isolated worktrees from exact remote heads. Preserve existing dirty
work. Record status, head, upstream, and remote head. Keep remediation narrow.
Recheck the exact head after any rebase or force-push. Generated verification
output must not contaminate the implementation diff.

Reconcile managed infrastructure through IaC. Review every plan. Stop on an
unexplained destroy, replacement, account, region, workspace, backend, state, or
runtime drift. Never place secret values in Terraform state.

## Destructive-action rule

Do not irreversibly delete or disable a cloud resource solely because it seems
unused. First prove consumers, state, backup/export need, replacement health,
traffic and DNS movement, hidden dependencies, rollback, monitoring, credential
rotation, and required approval. Prefer quarantine and staged disablement. Never
delete the only copy of data, state first, or a secret before all consumers rotate.

## Stop conditions

Pause the affected lane immediately when:

- a secret or private key is exposed;
- a service reports a chain other than `84532`;
- Terraform proposes an unexpected destroy or targets the wrong authority;
- a deployed digest cannot be traced to source and its producer;
- AWS and GCP writers are simultaneously authoritative for singular state;
- runtime IAM differs materially from the reviewed policy;
- cross-database isolation fails;
- callback or replay testing creates an unsafe transition;
- contract bytecode, constructor, or roles differ from the accepted artifact;
- a settlement rehearsal cannot reconcile;
- DNS would remove the only working path without tested rollback; or
- an allegedly inactive GCP resource has unexplained traffic or unique state.

## Audit-to-work-package routing

| Audit batches | Primary programme owner                                          |
| ------------- | ---------------------------------------------------------------- |
| 0-5           | WP-0, WP-5, WP-6, and WP-7 according to the finding              |
| 6-7           | WP-2 implementation; WP-9 live proof                             |
| 8-9           | WP-7 implementation; WP-10 independent verification              |
| 10            | WP-2, WP-4, and WP-8                                             |
| 11            | WP-7 and WP-8 implementation; WP-9 live proof                    |
| 12-13         | WP-1 implementation and acceptance; WP-9 convergence proof       |
| 14            | WP-3 implementation; WP-9 live proof                             |
| 15            | WP-8                                                             |
| 16-18         | Reopen the owning work package; WP-10 verifies closure           |
| 19            | WP-7 or WP-8 before candidate freeze                             |
| 20            | WP-9                                                             |
| 21            | Readiness after WP-9; deletion after WP-10 and explicit approval |
| 22-24         | WP-10 final acceptance and WP-11 handoff                         |

## Batch 0 - reconstruct previous execution

Identify exact branches, commits, PRs, issues, workflows, deployments, task
revisions, IaC changes, environment changes, AWS and GCP mutations, secrets, RPC
configuration, and contract evidence. Inspect actual diffs, dirty worktrees,
merged and unmerged work, remote heads, CI, deployment records, later changes,
and drift. Build a claims-versus-evidence matrix. Do not remediate except an
active critical exposure or wrong-chain condition.

Exit: source/deployment identity table, claims matrix, and explicit access gaps.

## Batch 1 - repository and configuration truth

Search source, history, scripts, IaC, containers, workflows, manifests, examples,
tests, runbooks, and generated templates for Cotsel and callback URLs, credentials,
replay stores, RPCs, chain IDs, contract/USDC/oracle/treasury addresses, indexer
blocks, reconciliation settings, GCP endpoints, cloud identifiers, regions,
environment aliases, old wallet references, and deprecated Polkadot paths.
Classify each as canonical, duplicate, historical, test-only, deprecated, unsafe,
or unexplained. Resolve unexplained and split-brain configuration. Prove critical
configuration fails closed without development, local, or historical fallback.

## Batch 2 - full AWS inventory and drift

Identify relevant accounts and their purpose. Inventory every relevant region for
ECS, ECR, ALB, target groups, listeners, CloudFront, VPC, subnets, routes, IGW,
NAT, EIP, endpoints, Route 53, security groups, IAM, Secrets Manager, KMS, RDS,
ElastiCache, SQS/DLQ, EventBridge, S3, CloudWatch, CloudTrail, GuardDuty, Security
Hub, Config, Backup, Lambda, API Gateway, and residual EC2. Record owner, consumer,
purpose, environment, state, traffic, monitoring, timestamps, and IaC ownership.
Run protected refresh plans and explain drift before reconciliation.

## Batch 3 - full GCP inventory and migration matrix

Discover all accessible Agroasys and Cotsel projects. Inventory Compute Engine,
Cloud Run, GKE, App Engine, Cloud SQL, Firestore, Storage, Pub/Sub, secrets, KMS,
VPC, load balancers, NAT, IPs, DNS, service accounts, IAM, registries, functions,
schedulers, tasks, logging, monitoring, and blockchain configuration. Inspect VM
containers, mounts, checkouts, local images, restart policies, environment names,
and traffic. For every resource record consumer, statefulness, classification,
AWS target, parity, traffic, rollback, credential rotation, and disposition.

## Batch 4 - stateful data and authority

Treat compute separately from state. For required database migration, compare
schema, migrations, counts, critical financial aggregates, identifiers,
timestamps, constraints, indexes, and representative checksums without destructive
queries. Detect old writers, dual writes, and post-cutover-only records. Verify
backup and PITR. For objects compare inventory, metadata, checksums, encryption,
retention, versioning, and policy. For queues prove drain or safe replay, consumer
cutover, idempotency, and absence of old publishers. If the approved lane starts
fresh, prove the historical boundary and non-colliding fixture identity instead
of fabricating migration parity.

## Batch 5 - AWS identity, IAM, secrets, and leakage

Inspect execution, task, migration, bootstrap, deployment, CI, operator, and
developer roles; policies; trust; federation; KMS; and cross-account access.
Match least privilege to actual calls. Prove execution/application separation and
who reads secrets or decrypts data. Prove directional service credentials are
distinct. Scan source and history, task plaintext, Terraform state, GitHub,
CloudWatch, issues, evidence, bundles, source maps, and environment files without
printing matches. Rotate and revoke an exposed credential through approved stores.

## Batch 6 - service authentication

Trace backend-to-Cotsel and Cotsel-to-backend sender and receiver code. Prove
agreement on key identifier, timestamp, nonce, body hash, signed method/path/query,
signature encoding, and HMAC algorithm. Test valid, tampered, unknown, disabled,
expired, future, malformed, missing, duplicate, invalid-hash, and invalid-encoding
cases. Responses must not reveal cryptographic detail. Repeat against staging with
a real Cotsel-generated callback and prove durable idempotent processing.

## Batch 7 - persistent replay protection

Trace deployed configuration to the instantiated store. Prove shared persistence,
TLS, atomic first-write, TTL, namespace, cleanup, clock skew, multi-task behavior,
and fail-closed behavior. Accept a nonce, restart within its TTL, and require the
replay to fail. Where multiple tasks exist, send first use and replay to different
tasks. A process-local test is insufficient.

## Batch 8 - network and ingress

Trace client, Cloudflare, CDN, ALB, target, task, and private dependencies. Inspect
DNS, proxy state, TLS, certificates, WAF, rate limits, origin bypass, subnet and
public-IP placement, and security-group ingress/egress. Prove any Cloudflare-only
origin control. Validate stable NAT/EIP egress before provider allowlisting.
Classify VPC endpoints as required controls or optional cost/architecture choices.

## Batch 9 - ECS runtime

For gateway, auth, oracle, indexer, reconciliation, Treasury, Ricardian, and every
discovered component, capture cluster, service, counts, task definition, digest,
source, resources, network, roles, secrets, plaintext environment, health,
readiness, logs, deployment, scaling, and restart behavior. Prove running tasks
use the intended definitions and immutable artifacts. Reject active GCP, old RPC,
old contract, old database, and deprecated secret references.

## Batch 10 - durable workflows, queues, and events

Identify each critical producer, consumer, queue, DLQ, visibility timeout, retry,
redrive, idempotency key, encryption, IAM, metric, alarm, and outbox. Prove Redis
is not canonical financial truth. Prove authenticated callbacks persist work and
do not perform unsafe settlement transitions in the request thread. Exercise a
safe retry, DLQ, and redrive fixture.

## Batch 11 - Base Sepolia RPC correctness

Identify independent managed providers and secret identifiers. For each, require
`eth_chainId = 0x14a34`, current block, accepted-contract read, USDC read, latency,
and availability. Build a consumer matrix. Prove startup chain rejection and
runtime behavior. Fail over only on transport/provider failure, never merely on a
revert or deterministic caller/application error. Force primary failure using an
isolated reviewed test configuration, prove fallback, wrong-chain rejection, both
providers unavailable, recovery to primary, and operator-visible signals.

## Batch 12 - contract deployment truth

Retrieve chain, address, transaction, block, source commit, compiler and settings,
constructor, ABI, creation and runtime bytecode, USDC, owner, governance, oracle,
treasury roles, explorer verification, and wallet posture. Rebuild from the exact
commit in a clean environment and compare using the repository method. Prove role
and authority transfer. Do not mutate contract state unless a safe staging runbook
requires it. Missing provenance prevents `VERIFIED`.

## Batch 13 - contract-address convergence

Establish one independently accepted staging address. Search and inspect every
gateway, oracle, indexer, reconciliation, Treasury, necessary backend, dashboard,
script, runbook, IaC, task, secret/config store, and GCP remnant. Prove each active
consumer uses the address and deployment/start block through representative reads.
Historical addresses may exist only as clearly historical evidence.

## Batch 14 - indexer and reconciliation

Prove canonical EVM event identity, unique ingestion, current ABI, correct start
block, repeatable backfill, durable restart, confirmations, and reorg handling.
Remove active Polkadot-specific identity semantics. Prove reconciliation compares
independently sourced normalized chain and operational facts, records drift
durably, cannot move funds, accepts a known-good fixture, and surfaces a safe
negative rehearsal.

## Batch 15 - observability and alerting

Prove retained structured and redacted logs, correlation IDs, metrics, actionable
alarms, and a tested notification destination for gateway/auth/oracle failure,
indexer lag, reconciliation drift, callback auth failures, replay, primary RPC
failure, fallback, wrong chain, both RPCs unavailable, low wallet balance, queue
and DLQ buildup, settlement execution failures, database health, and ECS rollback.
Avoid noisy alarms. An alarm without delivery is not a control.

## Batch 16 - security-control verification

Verify auditable privilege, session/signer separation, service/operator credential
separation, immutable customer principal, fee/principal segregation, PII and
document exclusion from chain/logs, authenticated replay-safe idempotent callbacks,
real reconciliation, absence of embedded broad cloud credentials, and no active
stale GCP service-account key. Prefer short-lived workload federation.

## Batch 17 - migration parity and residual dependencies

Compare AWS and GCP capability by actual semantics. For each migration item prove
the AWS target exists, contains required configuration/state, receives active
traffic, has no old GCP producer dependency, and has known rollback/decommission
status. Inspect Cloudflare, DNS, GitHub, CI/CD variables and secrets, callback and
webhook URLs, provider allowlists, RPC restrictions, and monitoring destinations.

## Batch 18 - remediate proved gaps

After inventory and dependency mapping, remediate in this order: active security
exposure, wrong runtime/configuration, state inconsistency, authentication/replay,
contract/RPC, migration, durability, observability, orphaned resources, then cost.
Keep fixes narrow, preserve control/execution boundaries, provider abstraction,
non-custodial design, and service responsibilities. Every fix requires code and/or
live proof appropriate to the defect.

## Batch 19 - efficiency and unnecessary resources

After correctness, identify unused or oversized ECS, load balancers, targets,
NAT/EIP, disks, databases, secrets and versions, KMS keys, queues/DLQs, logs,
GCP resources, and RPC subscriptions. For every proposal document consumer,
removal rationale, risk, rollback, and expected benefit. Do not weaken resilience.

## Batch 20 - fresh live staging proof

Using the frozen deployed candidate, prove gateway health, backend signed request,
tamper rejection, persistent replay rejection, real authenticated callback, both
RPCs, forced failover and recovery, accepted contract, oracle, indexed event,
reconciliation, durable workflow, queue behavior, and settlement-visible result.
Use the narrowest approved Base Sepolia fixture. Record redacted trace IDs,
messages, tasks, transaction, blocks, event identity, and alarm delivery. Do not
forge callbacks or insert database rows to bypass missing integration.

## Batch 21 - GCP decommission readiness

After Batch 20 passes, recheck every migration-related GCP resource for traffic,
writers, webhooks, DNS, CI/CD, unique state, exports, replacement proof, rotation,
rollback window, and approval. Produce a decommission packet. If approved, remove
traffic, observe, stop workload, observe, revoke credentials, retain backup, then
delete only after final approval. Never delete state first.

## Batch 22 - independent second pass

A counterpart starts from current external truth, not the implementer report.
Re-query AWS and GCP, refresh plans, task definitions and digests, IAM, secret
references, networking, grants, service auth, callbacks, cross-task replay, both
RPCs and failover, contract build/provenance, address convergence, indexer,
reconciliation, queues, alarms and notification, repository/history leakage,
DNS, Cloudflare, provider restrictions, CI/CD, and every GCP disposition. A new
material gap reopens its owning work package.

## Batch 23 - issue, runbook, and evidence reconciliation

Only after runtime proof, update architecture, accounts/regions, service and role
maps, secret identifiers, deployment, auth/callback, replay, RPC/failover, contract,
indexer/reorg, reconciliation, queue/redrive, alarm response, dashboard, GCP,
DNS/Cloudflare rollback, fresh-lane policy, retained dependency, and known-limit
runbooks. Mark historical material clearly. Do not document intended state as live.

## Batch 24 - final completion gate

The final report is `COMPLETE`, `PARTIALLY COMPLETE`, or `BLOCKED`. `COMPLETE`
requires reproducible affirmative evidence for every item below:

- every active staging workload and relevant GCP resource is identified;
- every required AWS target and state boundary is proved;
- no unintended live dependency crosses into GCP;
- secrets are confined to approved stores and IAM matches runtime need;
- both signed directions, tamper rejection, and persistent replay rejection work;
- two independent RPCs report chain `84532`; failover and recovery work;
- one contract is independently accepted and reproducibly matches its source;
- all consumers use its address and block;
- oracle, indexer, reconciliation, queues, DLQs, and failure visibility work;
- the dashboard release and external origins are reproducible and current;
- stale infrastructure is removed, quarantined, or explicitly retained;
- documentation matches reality; and
- a second engineer reproduced the critical evidence.

The report must include previous-claims audit, AWS state, GCP state and disposition,
migration statement, security/identity statement, Base Sepolia statement,
operational readiness, efficiency, residual risks, and a plain-language conclusion.

## Blocker report

For a blocked batch, state:

1. the exact missing access, value entry, resource, approval, or decision;
2. why it is required;
3. what is already proved;
4. the exact safe action another operator must take; and
5. what will be validated afterward.

Never request a secret, private key, seed phrase, or authenticated RPC URL in chat.

## Batch report format

Every batch record must state:

- **Batch verdict:** `VERIFIED`, `REMEDIATED AND VERIFIED`,
  `PARTIALLY VERIFIED`, or `BLOCKED`.
- **What you inspected:** exact repositories, resources, configuration, and runtime.
- **What you found:** proved gaps or confirmation.
- **What you changed:** only actual mutations.
- **How you proved it:** commands, queries, tests, and exercises.
- **What remains:** unresolved work before the next dependent gate.

Avoid language such as "looks good", "should work", or "appears complete".

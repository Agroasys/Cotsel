# Service Liveness and Dependency Readiness

What each financial-path service's readiness probe proves, how it behaves when a
dependency fails, and the dependency fault drill.

- **Owner:** Platform and service owners
- **Traceability:** WP-7, finding H-07; contributes to INFRA-05 and FAIL-16 ([Agroasys/Cotsel#670](https://github.com/Agroasys/Cotsel/issues/670))
- **Primary gate:** E-4 (platform)

## Liveness and readiness are different signals

| Signal    | Question it answers                                      | Depends on                  |
| --------- | -------------------------------------------------------- | --------------------------- |
| Liveness  | Is the process running and able to answer HTTP?          | Nothing outside the process |
| Readiness | Can the process safely serve its configured profile now? | Its required dependencies   |

Liveness must stay green while a dependency is down: restarting the process does
not repair an RPC, KMS, database, or indexer outage. Readiness must go red, so
that whatever routes or promotes on it stops sending financial work.

## What each service requires

Every listed dependency is required: if any one is unavailable, readiness
returns `503` with `ready: false`. A dependency that is not part of the running
profile is reported as `status: "disabled"` with `required: false`, never as `ok`.

| Service  | Liveness                                | Readiness                              | Required dependencies                                                                                                                                                                          |
| -------- | --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway  | `GET /api/dashboard-gateway/v1/healthz` | `GET /api/dashboard-gateway/v1/readyz` | `postgres`, `auth-service`, `chain-rpc`, `indexer-graphql`; with gasless execution enabled, `gasless-relayer-policy`, plus `gasless-relayer` under KMS custody                                 |
| Oracle   | `GET /api/oracle/health`                | `GET /api/oracle/ready`                | `postgres`, `chain-rpc`, `oracle-signer`, `indexer-graphql`, `reconciliation-containment` (reported `disabled` only outside staging and production)                                            |
| Treasury | `GET /api/treasury/v1/health`           | `GET /api/treasury/v1/ready`           | `postgres`, `reconciliation-reader` when a reconciliation database is configured, then chain-evidence ingestion freshness ([treasury-ingestion-freshness.md](treasury-ingestion-freshness.md)) |
| Relayer  | `GET /api/relayer/health`               | `GET /api/relayer/ready`               | `kms-signer`, and `replay-store` when Redis replay protection is configured                                                                                                                    |

Dependency-specific rules:

- **Gateway `auth-service`:** probes Auth's `GET /api/auth/v1/ready`, which
  checks Auth's database. Auth's `/health` is liveness only and stays green while
  session resolution is unusable.
- **Gateway `gasless-relayer`:** under KMS custody, calls the standalone
  relayer's `GET /api/relayer/ready` (at `GATEWAY_GASLESS_MANAGED_SIGNER_URL`)
  under the probe timeout, so a stopped relayer, an unusable KMS key, or a lost
  replay store fails gateway readiness before any request has failed. MPC custody
  signs through an external provider and is not probed here.
- **Gateway `gasless-relayer-policy`:** the gateway's local queue and policy
  snapshot, with no network call. Unavailable when the snapshot
  is `blocked` (critical capacity or balance policy breach). A deliberate
  `paused` state is an operator control, not a dependency failure, and stays
  ready. The full snapshot remains at `GET /api/dashboard-gateway/v1/operations/gasless-relayer/readiness`.
- **Oracle `oracle-signer`:** probes the configured custody now rather than
  trusting the address cached at startup. KMS custody reads the key with
  `GetPublicKey` and refuses a key whose address no longer matches
  `ORACLE_KMS_EXPECTED_ADDRESS`. Managed custody asks the signer for its address
  and refuses one that changed since startup. KMS also signs a fresh, domain-separated
  readiness challenge and verifies its signature against the reviewed address.
  Managed custody calls the existing transaction-signing route with a fresh challenge,
  zero value, and zero gas. It verifies the returned transaction without broadcasting it.
  Zero gas prevents this challenge from executing on chain. Signing denial fails readiness.
- **Oracle `reconciliation-containment`:** the containment guard fails closed,
  so an unreachable reconciliation reader already stops every progression.
  Readiness reports that instead of staying green. With no reconciliation reader
  configured (`RECONCILIATION_DB_*`), progressions are not gated: in `staging` and
  `production` (`COTSEL_ENVIRONMENT`, falling back to `NODE_ENV`) readiness
  fails; in any other profile the dependency is reported `disabled`.
- **Relayer `kms-signer`:** the same fresh `GetPublicKey` check against
  `RELAYER_KMS_EXPECTED_ADDRESS`, followed by a fresh signed readiness challenge.

## Probe behavior

- Every dependency check runs in parallel under its own timeout (3 seconds by
  default; the gateway uses `GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS`). A hung
  dependency is reported as `reason: "timeout"` instead of stalling the probe.
- Responses list each dependency as `{ name, required, status, reason?, durationMs? }`.
  They never include error text: dependency errors routinely embed RPC URLs with
  API keys, database users, KMS key identifiers, or hosts, and readiness is
  unauthenticated.
- A successful signer probe is reused for 60 seconds so readiness does not call
  KMS on every probe. A failure is never cached: the next probe tries again.

## Routing: open decision

Readiness is now truthful, but in staging nothing routes on it yet. ECS container
health checks, the gateway ALB target group, and Cloud Map registration all use
liveness. That is deliberate for now: on ECS a failing load-balancer health
check also makes ECS replace the task, so pointing the ALB at `/readyz` would
turn a dependency outage into a restart loop rather than a traffic removal.

Until the WP-7 infrastructure lane decides how readiness removes traffic (for
example by gating callers on downstream readiness before committing financial
work, or by a routing layer that does not replace tasks on readiness failure),
treat a red readiness probe as a paging signal and a promotion blocker, not as
automatic traffic removal.

## Dependency fault drill

Run against the exact candidate in the target environment, one dependency at a
time. Record the candidate identity, the probe responses, and timestamps.

1. **Baseline.** Every readiness endpoint above returns `200` with all
   dependencies `ok`, and every liveness endpoint returns `200`.
2. **Inject one fault.** For example: block the RPC endpoint from the task
   security group, revoke `kms:GetPublicKey` on the signer key, stop the
   indexer GraphQL service, stop the standalone relayer, or revoke the
   reconciliation reader's database access.
3. **Observe.** Within one probe interval the affected service's readiness
   returns `503`, names the dependency with `status: "unavailable"`, and shows
   no error text. Liveness for the same service stays `200` and ECS does not
   replace the task.
4. **Recover.** Remove the fault. Readiness returns `200` on the next probe;
   for a signer fault, within the next probe after the failure (failures are
   not cached).
5. **Record.** Attach the probe transcripts to the candidate evidence bundle.

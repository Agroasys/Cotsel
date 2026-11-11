# Settlement Observability: Dashboard, SLO Alarms, and Synthetics

The deployed staging telemetry for Cotsel settlement: what each alarm means, who
responds, and how to capture evidence.

- **Owner:** Platform On-Call (operations), Incident Commander (CRITICAL response)
- **Traceability:** WP-8, findings B-17, COMP-04, INFRA-08, REPORT-04 ([Agroasys/Cotsel#671](https://github.com/Agroasys/Cotsel/issues/671))
- **Terraform:** `infra/terraform/staging-platform/observability.tf`, `observability-dashboard.tf`, `settlement-signals.json`
- **Guard:** `infra/terraform/scripts/settlement-observability.test.mjs`
- **Primary gates:** E-5 (operations), P-4 (operational readiness)

## What it provides

| Surface           | Name in AWS                                              | Purpose                                                                                              |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Dashboard         | `cotsel-staging-settlement`                              | Gateway SLO, latency, readiness, running tasks, and every settlement signal by domain                |
| Metric namespace  | `Cotsel/Settlement/staging`                              | Dimensionless counters and freshness values derived from service logs                                |
| Correlation query | `cotsel-staging/settlement/correlation-trace`            | One identifier traced across every service log group                                                 |
| Error query       | `cotsel-staging/settlement/errors-by-service`            | Error records grouped by service and message                                                         |
| Synthetic probe   | Route 53 health check `cotsel-staging-gateway-readiness` | Three regions request `/api/dashboard-gateway/v1/readyz` through CloudFront and WAF every 30 seconds |
| Terraform output  | `settlement_observability`                               | Dashboard, namespace, query, probe, routing state, and the full alarm list for evidence capture      |

## Privacy model (COMP-04)

Nothing here adds instrumentation. Every signal is a CloudWatch metric filter
over records that services already write through the shared default-deny
telemetry schema (`shared-telemetry`), so this layer cannot widen what reaches
telemetry.

- Matchers may use only `public_operational` fields. The guard test enforces this
  with the same field classifier the services use.
- Metric filters never publish dimensions. Trade, wallet, account, and transaction
  identifiers never become metric keys, so they are absent from the dashboard and
  from metric retention.
- Identifiers stay in the service log groups. Those use KMS encryption, follow
  `log_retention_days`, and are reachable only through IAM-controlled Logs
  Insights, including the saved correlation query.
- The readiness probe sends no credential, identity, or body.

## Signal catalog

`infra/terraform/staging-platform/settlement-signals.json` is the single source
for every log-derived metric and its alarm. Each signal names its log group, the
exact field values that match, and an optional alarm. Conditions are AND-ed; the
values inside one condition are OR-ed.

The guard test fails when a matched message, metric name, or event type no longer
appears in the emitting service source. **If you rename a log message that a
signal matches, update the catalog in the same pull request.** Otherwise the
alarm goes silent without any warning.

Add a signal:

1. Make sure the service already emits the record with a stable `message`, `msg`,
   `metric`, or `eventType` value, using only `public_operational` fields.
2. Add the catalog entry. Use `"kind": "event"` for occurrences and
   `"kind": "heartbeat"` for a record that must keep arriving.
3. Add the alarm ID to the response table below.
4. Run `node --test infra/terraform/scripts/settlement-observability.test.mjs`.

## Alarm routing

Severity routing follows `monitoring-alerting-baseline.md` (decision #199).

| Severity | Terraform input                                 | Routing                                       | Target acknowledgement |
| -------- | ----------------------------------------------- | --------------------------------------------- | ---------------------- |
| CRITICAL | `critical_alarm_topic_arns`                     | Platform On-Call (pager) + Incident Commander | <= 10 minutes          |
| HIGH     | `high_alarm_topic_arns`                         | Ops/Engineering On-Call                       | <= 30 minutes          |
| HIGH     | `edge_alarm_topic_arns` (us-east-1, probe only) | Ops/Engineering On-Call                       | <= 30 minutes          |

All three lists default to empty. Alarms still evaluate and show on the
dashboard, but **no one is paged until the Operations Lead names subscribed,
confirmed destinations (#672).** The `settlement_observability` output reports
`critical_alarms_routed` and `high_alarms_routed`, so an unrouted deployment is
visible in every plan. `edge_alarms_routed` does the same for the readiness
probe, which routes only through `edge_alarm_topic_arns`. An unrouted deployment
does not satisfy E-5 or P-4.

## Gateway SLO

Objective: `gateway_availability_slo_percent` (default 99.9% monthly, decision
#199). The error ratio is ALB target 5xx plus load-balancer 5xx, divided by ALB
requests plus load-balancer 5xx. ALB `RequestCount` leaves out requests the load
balancer answered itself, such as 503s with no healthy target. Without the
load-balancer 5xx in the denominator, a full outage would read as zero requests
and neither burn alarm would fire.

| Alarm                   | Rule                                                                    | Severity |
| ----------------------- | ----------------------------------------------------------------------- | -------- |
| `gateway_slo_fast_burn` | Ratio > 14.4 × budget over both 1 hour and 5 minutes                    | CRITICAL |
| `gateway_slo_slow_burn` | Ratio > 6 × budget over both 6 hours and 30 minutes                     | HIGH     |
| `gateway_latency_p99`   | p99 target response > `gateway_latency_p99_seconds` (2s) for 15 minutes | HIGH     |

A 14.4x burn spends 2% of a 30-day budget in one hour. The short window clears
the alarm quickly once the fault stops. The four component alarms
(`cotsel-staging-gateway-slo-burn-*`) route nowhere on their own.

The readiness probe goes through the same load balancer, so its requests count
toward the SLO. On staging, where real traffic is thin, the probe can be most of
the traffic. A readiness `503` that lasts five minutes then raises
`gateway_slo_fast_burn` (CRITICAL) as well as `gateway_readiness_probe` (HIGH).
This is intended: a failing `/readyz` means the gateway has failed closed and
refuses financial operations, which is a real outage for users. Treat the two
alarms as one incident and work it from the CRITICAL row.

## Alarm responses

Start every incident with the saved correlation query. Replace `REPLACE_WITH_ID`
with the `correlationId`, `requestId`, `tradeId`, or `txHash` from the first
failing record. Capture the evidence listed in
`monitoring-alerting-baseline.md` (Incident Evidence Checklist).

| Alarm ID                                 | Severity | First response                                                                                                | Detailed runbook                           |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `gateway_slo_fast_burn`                  | CRITICAL | Check the readiness probe and running tasks; roll back the last release if it started after deployment        | `aws-staging-platform.md`                  |
| `gateway_slo_slow_burn`                  | HIGH     | Run the errors-by-service query and open a ticket with the dominant error                                     | `dashboard-gateway-operations.md`          |
| `gateway_latency_p99`                    | HIGH     | Compare the database, RPC, and downstream service latency; check `/readyz` dependencies                       | `service-readiness.md`                     |
| `gateway_readiness_probe`                | HIGH     | Request `/readyz` directly; a `503` names the failing financial dependency                                    | `service-readiness.md`                     |
| `service_running_tasks`                  | HIGH     | Inspect ECS stopped-task reasons and the circuit-breaker rollback for the named service                       | `aws-staging-platform.md`                  |
| `indexer_poison_log_quarantined`         | CRITICAL | Do not advance the checkpoint by hand. Freeze dependent flows and follow the quarantine replay procedure      | `indexer-poison-log-recovery.md`           |
| `indexer_startup_blocked`                | CRITICAL | Read `eventType` and resolve the quarantine or chain/ABI gate before restarting                               | `indexer-poison-log-recovery.md`           |
| `reconciliation_drift_critical`          | CRITICAL | Open an incident; verify chain, indexer, and reconciliation parity for the affected trade                     | `reconciliation.md`                        |
| `reconciliation_coverage_gap`            | CRITICAL | The cursor is held. Backfill or replay the range, then rerun reconciliation                                   | `reconciliation-chain-coverage.md`         |
| `reconciliation_containment_breach`      | CRITICAL | Pause the affected trade on chain through the scoped control and record the incident reference                | `emergency-disable-unpause.md`             |
| `reconciliation_run_abandoned`           | HIGH     | Confirm a successor claimed the run; never repair the lease with direct SQL                                   | `reconciliation-run-leases.md`             |
| `reconciliation_run_failed`              | HIGH     | Read the failing run's error and confirm the next daemon cycle succeeds                                       | `reconciliation.md`                        |
| `treasury_ingestion_runs`                | CRITICAL | Ingestion has emitted nothing for 15 minutes. Export and close are blocked; restore the worker, then backfill | `treasury-ingestion-freshness.md`          |
| `treasury_ingestion_blocked`             | HIGH     | Read the run outcome; repair the RPC or canonical-evidence dependency                                         | `treasury-ingestion-freshness.md`          |
| `treasury_ingestion_stale`               | CRITICAL | Evidence is stale or lagging; export and close will block. Repair ingestion before any close                  | `treasury-ingestion-freshness.md`          |
| `treasury_reorg_orphan`                  | CRITICAL | Hold export for the affected period and re-derive canonical evidence                                          | `treasury-canonical-chain-evidence.md`     |
| `gateway_transaction_outcome_unknown`    | CRITICAL | Do not rebroadcast. Resolve the outcome by hash                                                               | `gasless-transaction-outcome-recovery.md`  |
| `gateway_transaction_persistence_failed` | CRITICAL | Check gateway database health; the transition must be recovered before new gasless work                       | `gasless-transaction-outcome-recovery.md`  |
| `managed_signer_rejected`                | HIGH     | Treat the signer response as untrusted; compare it with the canonical intent                                  | `managed-signer-intent-binding.md`         |
| `oracle_signer_rejected`                 | HIGH     | Treat the signer response as untrusted; compare it with the canonical intent                                  | `managed-signer-intent-binding.md`         |
| `settlement_callback_stalled`            | CRITICAL | Agroasys is not receiving settlement events. Check the callback lease and backend reachability                | `gateway-dead-letter-workflow.md`          |
| `settlement_callback_delivery_failed`    | HIGH     | Check backend callback health and credentials; deliveries retry from the durable outbox                       | `gateway-dead-letter-workflow.md`          |
| `oracle_execution_unresolved`            | CRITICAL | Do not re-drive until the original dispatch outcome is known                                                  | `oracle-redrive.md`                        |
| `oracle_containment_unreadable`          | CRITICAL | The Oracle failed closed. Restore containment-store reachability                                              | `oracle-redrive.md`                        |
| `oracle_exhausted_retries`               | HIGH     | Review the trigger and re-drive through the approved maker-checker path                                       | `oracle-redrive.md`                        |
| `relayer_replay_rejected`                | HIGH     | Treat as a suspected replay until explained; review the caller credential                                     | `secrets-and-token-rotation.md`            |
| `relayer_request_failed`                 | HIGH     | Check relayer KMS, RPC, and sponsor-policy health                                                             | `base-sepolia-gasless-settlement-proof.md` |

## Evidence capture

For a candidate-bound E-5 or P-4 packet, record:

1. `terraform output -json settlement_observability` for the applied candidate.
2. Dashboard screenshots or exports covering the release time range.
3. An injected-incident drill for one CRITICAL signal, showing the alarm
   transition, delivery receipt, acknowledgement, and the correlation-query result.
4. A seeded-sensitive-field check showing that the telemetry schema dropped or
   redacted the field (`scripts/tests/telemetry-field-schema-guard.test.mjs`).

## Known limits

- Routing to named owners stays open until #672 assigns topics. Without it, no
  page is delivered.
- Log-derived metrics see only records that are written. Silence is detected only
  for treasury ingestion (a heartbeat) and for stopped tasks (running-task alarms).
- End-to-end correlation joins on `correlationId`, `requestId`, `tradeId`, and
  `txHash` where services already log them. It does not yet carry one trace
  identifier from the Agroasys order through the queue and the chain receipt.
- The indexer lag SLO is still measured by `scripts/runtime-gate.sh`, not by a
  deployed metric.

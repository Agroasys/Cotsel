# Monitoring and Alerting Baseline

## Scope and Non-goals
- Define a deterministic monitoring and alerting baseline for in-repo pilot operations.
- In scope services: `oracle`, `indexer`, `reconciliation`, `treasury`, `ricardian`, `notifications`.
- This runbook defines required signals, thresholds, escalation rules, and evidence capture.
- Non-goal: this repository does not configure or provision an external observability SaaS stack.
- Non-goal: this runbook does not add runtime instrumentation or change protocol/on-chain behavior.
- Gateway note: no dedicated gateway runtime exists in this repository; service-directed behavior is documented in `docs/runbooks/api-gateway-boundary.md`.

## Service Reality Mapping
Runtime evidence sources:
- Compose profiles and service definitions: `docker-compose.services.yml`.
- Profile health and endpoint checks: `scripts/docker-services.sh`.
- Staging release gate signals and reports: `scripts/staging-e2e-real-gate.sh`.
- Notification route and template validation: `scripts/notifications-gate.sh`, `scripts/notifications-gate-validate.mjs`.
- CI evidence source: `.github/workflows/release-gate.yml`.

Services in scope:
- `oracle`
- `indexer`
- `reconciliation`
- `treasury`
- `ricardian`
- `notifications`

Runtime mapping:

| Service | Local Runtime Surface | Staging Runtime Surface | Primary Health Signal Source |
| --- | --- | --- | --- |
| oracle | `oracle` container | `oracle` container | `scripts/docker-services.sh health <profile>` (`/api/oracle/health`) |
| indexer | `indexer` container | `indexer-pipeline` + `indexer-graphql` | `scripts/staging-e2e-real-gate.sh` (`lag/head metrics`) |
| reconciliation | `reconciliation` container | `reconciliation` container | `scripts/docker-services.sh health <profile>` + `reconciliation/dist/healthcheck.js` |
| treasury | `treasury` container | `treasury` container | `scripts/docker-services.sh health <profile>` (`/api/treasury/v1/health`) |
| ricardian | `ricardian` container | `ricardian` container | `scripts/docker-services.sh health <profile>` (`/api/ricardian/v1/health`) |
| notifications | library inside oracle/reconciliation flows (no standalone container) | same | `scripts/notifications-gate.sh <profile>` report (`reports/notifications/<profile>.json`) |

## Service SLO Baseline
Pilot defaults approved in decision issue `#199`.

| Service | Availability SLO | Freshness / Latency Target | Error Budget Posture | Metric/Signal Reference |
| --- | --- | --- | --- | --- |
| oracle | 99.9% monthly | Active trigger should progress within 10 minutes when inputs are valid | Repeated breach pauses releases until fixed | `oracle_triggers` status age query (see Evidence Commands) |
| indexer | 99.9% monthly | Normal lag <= 2 minutes, alert when > 5 minutes | Repeated breach pauses releases until fixed | `scripts/staging-e2e-real-gate.sh` lag/head metrics |
| reconciliation | 99.9% monthly | Reconciliation cycle should complete without persistent critical drift | Repeated breach pauses releases until fixed | `reconcile_runs` + `reconcile_drifts` summary/report |
| treasury | 99.9% monthly | Treasury health endpoint remains healthy in active profile | Repeated breach pauses releases until fixed | `scripts/docker-services.sh health <profile>` |
| ricardian | 99.9% monthly | Ricardian health endpoint remains healthy in active profile | Repeated breach pauses releases until fixed | `scripts/docker-services.sh health <profile>` |
| notifications | 99.9% monthly | Critical-path gate validation remains passing per profile run | Repeated breach pauses releases until fixed | `scripts/notifications-gate.sh <profile>` |

## Alert Matrix
| Alert ID | Service | Signal / Threshold | Severity | Source | First Response | Escalation Owner | Evidence Command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `oracle_health_unhealthy` | oracle | Profile health check fails oracle endpoint | HIGH | `scripts/docker-services.sh health staging-e2e-real` | Capture logs and confirm env/profile parity | Ops/Engineering On-Call | `scripts/docker-services.sh logs staging-e2e-real oracle | tail -n 20` |
| `indexer_lag_gt_5m` | indexer | Indexer lag condition persists > 5 minutes | HIGH | `scripts/staging-e2e-real-gate.sh` lag/head metrics + incident timer | Re-run gate once from clean profile state | Ops/Engineering On-Call | `scripts/staging-e2e-real-gate.sh | tee reports/reconciliation/staging-e2e-real-gate-monitoring.txt` |
| `settlement_progress_stalled_10m` | oracle | Active trades not progressing for 10 minutes | CRITICAL | `oracle_triggers` stale active-status query | Freeze new pilot operations, investigate trigger backlog | Incident Commander | `docker compose -f docker-compose.services.yml --profile staging-e2e-real exec -T postgres psql -U \"$POSTGRES_USER\" -d \"$ORACLE_DB_NAME\" -Atc \"SELECT trade_id, trigger_type, status, updated_at FROM oracle_triggers WHERE status IN ('PENDING','EXECUTING','SUBMITTED','PENDING_APPROVAL') AND updated_at < NOW() - INTERVAL '10 minutes' ORDER BY updated_at ASC LIMIT 20;\"` |
| `reconciliation_critical_drift` | reconciliation | `CRITICAL` drifts detected in latest reconciliation run | CRITICAL | `scripts/staging-e2e-real-gate.sh` drift snapshot + reconciliation report | Open incident and verify chain/indexer/reconciliation parity | Platform On-Call + Incident Commander | `scripts/staging-e2e-real-gate.sh && cat reports/reconciliation/staging-e2e-real-report.json` |
| `treasury_health_unhealthy` | treasury | Treasury health endpoint fails | HIGH | `scripts/docker-services.sh health staging-e2e-real` | Capture treasury logs and DB connectivity signal | Ops/Engineering On-Call | `scripts/docker-services.sh logs staging-e2e-real treasury | tail -n 20` |
| `ricardian_health_unhealthy` | ricardian | Ricardian health endpoint fails | HIGH | `scripts/docker-services.sh health staging-e2e-real` | Capture ricardian logs and DB connectivity signal | Ops/Engineering On-Call | `scripts/docker-services.sh logs staging-e2e-real ricardian | tail -n 20` |
| `notifications_gate_failed` | notifications | Notification gate output fails deterministic route/template checks | HIGH | `scripts/notifications-gate.sh staging-e2e-real` + report JSON | Rebuild notifications workspace and rerun gate | Ops/Engineering On-Call | `npm run -w notifications build && scripts/notifications-gate.sh staging-e2e-real` |

## Severity Routing and Escalation Policy
Approved pilot routing from decision issue `#199`:

| Severity | Routing | Target Acknowledgement |
| --- | --- | --- |
| CRITICAL | Platform On-Call (pager) + Incident Commander | <= 10 minutes |
| HIGH | Ops/Engineering On-Call (chat + ticket) | <= 30 minutes |
| MEDIUM | Backlog issue | <= 1 business day triage |
| LOW | Backlog issue | <= 1 business day triage |

Role ownership:
- `Platform On-Call`: active Agroasys Web3layer operations owner.
- `Incident Commander`: Aston (pilot default).

## Suppression Policy
- `max_suppression_window`: `2h`
- `suppression_approver_role`: `Incident Commander`
- `suppression_audit_note_required`: `true`

Suppression record must include:
- suppression start/end timestamps,
- reason,
- linked incident or ticket URL.

## Incident Evidence Checklist
For every HIGH/CRITICAL incident record:
- timestamp (UTC),
- environment (`staging-e2e-real` or equivalent),
- affected component,
- last 20 log lines,
- relevant tx/extrinsic hash when on-chain correlation exists,
- current service health status,
- rollback decision (`yes` or `no`) with reason.

## Evidence Capture Commands
Baseline profile checks:

```bash
scripts/validate-env.sh staging-e2e-real
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
scripts/notifications-gate.sh staging-e2e-real
```

Service-specific log capture:

```bash
scripts/docker-services.sh logs staging-e2e-real oracle | tail -n 20
scripts/docker-services.sh logs staging-e2e-real reconciliation | tail -n 20
scripts/docker-services.sh logs staging-e2e-real treasury | tail -n 20
scripts/docker-services.sh logs staging-e2e-real ricardian | tail -n 20
scripts/docker-services.sh logs staging-e2e-real indexer-graphql | tail -n 20
```

Settlement progress stale-check query (10-minute threshold):

```bash
docker compose -f docker-compose.services.yml --profile staging-e2e-real exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$ORACLE_DB_NAME" -Atc \
  "SELECT trade_id, trigger_type, status, updated_at
   FROM oracle_triggers
   WHERE status IN ('PENDING','EXECUTING','SUBMITTED','PENDING_APPROVAL')
     AND updated_at < NOW() - INTERVAL '10 minutes'
   ORDER BY updated_at ASC
   LIMIT 20;"
```

Recent on-chain correlation snapshot:

```bash
docker compose -f docker-compose.services.yml --profile staging-e2e-real exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$INDEXER_DB_NAME" -Atc \
  "SELECT trade_id, tx_hash FROM trade_event ORDER BY block_number DESC LIMIT 20;"
```

## Staging-E2E-Real Release Evidence
Monitoring readiness in CI is demonstrated with these release-gate artifacts:
- `ci-report-monitoring-baseline`
- `ci-report-staging-e2e-real-gate`
- `ci-report-notifications-gate`
- `ci-report-reconciliation-report`
- `ci-report-release-gate`

Required evidence for release readiness:
1. Monitoring baseline validator passes (`ci-report-monitoring-baseline`).
2. Staging gate reports healthy profile checks and lag/head metrics.
3. Notifications gate report exists and passes deterministic critical-path checks.
4. Reconciliation report artifact is present for the run.

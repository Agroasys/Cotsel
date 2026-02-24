# Pilot KPI Collection and Report Template

## Purpose
Define measurable pilot outcomes for the Agroasys settlement protocol, provide reproducible
query templates against existing data sources, and structure a standard evidence bundle for
each completed pilot window.

## Who This Is For
- `Pilot Owner`: approves the final report and go/no-go for next stage.
- `Operator`: collects evidence and runs queries.
- `On-call Engineer`: interprets anomalies and attaches incident context.

## When To Use
- At close of every pilot window.
- As evidence input to production-readiness gates (`docs/runbooks/production-readiness-checklist.md`).
- During governance reviews or external audits.

## Scope
- Oracle trigger success rate and settlement latency.
- Reconciliation drift health (on-chain / off-chain parity).
- Gas profile against contract baseline.
- Chain and reconciliation evidence links.



## Section 1 — KPI Definitions

### KPI-1: Oracle Trigger Success Rate

**Definition**: Percentage of oracle triggers that reach `CONFIRMED` status without entering
`TERMINAL_FAILURE` or being `REJECTED`.

**Formula**:
```
success_rate = (CONFIRMED triggers / total_settled_triggers) * 100
```

Where `total_settled_triggers` = all triggers with a terminal status: `CONFIRMED | TERMINAL_FAILURE | REJECTED`.

**Baseline target**: 100% for pilot window.

**Data source**: `oracle_triggers` table — `oracle/src/database/schema.sql`.

**Query**:
```sql
SELECT
    trigger_type,
    COUNT(*) FILTER (WHERE status = 'CONFIRMED')                       AS confirmed,
    COUNT(*) FILTER (WHERE status = 'TERMINAL_FAILURE')                AS terminal_failure,
    COUNT(*) FILTER (WHERE status = 'REJECTED')                        AS rejected,
    COUNT(*) FILTER (WHERE status IN ('CONFIRMED','TERMINAL_FAILURE','REJECTED')) AS total_settled,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'CONFIRMED')
        / NULLIF(COUNT(*) FILTER (WHERE status IN ('CONFIRMED','TERMINAL_FAILURE','REJECTED')), 0),
        2
    ) AS success_rate_pct
FROM oracle_triggers
WHERE created_at BETWEEN :from AND :to
GROUP BY trigger_type
ORDER BY trigger_type;
```

**Caveats**:
- Triggers still in `PENDING`, `EXECUTING`, `SUBMITTED`, or `PENDING_APPROVAL` at report time
  are excluded from the denominator; re-run the query once the pilot window is fully settled.


### KPI-2: Settlement Latency

**Definition**: Elapsed time (seconds) per trigger type from trigger creation to on-chain
confirmation.

**Sub-metrics**:

| Sub-metric | Description |
|---|---|
| `p50_latency_s` | Median time (created_at -> confirmed_at) |
| `p95_latency_s` | 95th-percentile latency |
| `max_latency_s` | Maximum observed latency |
| `avg_attempt_count` | Average retry attempts before confirmation |

**Baseline targets** (pilot window):

| Trigger type | p50 target | p95 target |
|---|---|---|
| `RELEASE_STAGE_1` | ≤ 60 s | ≤ 300 s |
| `CONFIRM_ARRIVAL` | ≤ 60 s | ≤ 300 s |
| `FINALIZE_TRADE` | ≤ 60 s | ≤ 300 s |

**Data source**: `oracle_triggers` — columns `created_at`, `confirmed_at`, `attempt_count`.

**Query**:
```sql
SELECT
    trigger_type,
    COUNT(*) AS sample_count,
    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY
        EXTRACT(EPOCH FROM (confirmed_at - created_at)))::numeric, 2) AS p50_latency_s,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY
        EXTRACT(EPOCH FROM (confirmed_at - created_at)))::numeric, 2) AS p95_latency_s,
    ROUND(MAX (EXTRACT(EPOCH FROM (confirmed_at - created_at)))::numeric, 2) AS max_latency_s,
    ROUND(AVG (attempt_count)::numeric, 2)                              AS avg_attempt_count
FROM oracle_triggers
WHERE status = 'CONFIRMED'
  AND confirmed_at IS NOT NULL
  AND created_at BETWEEN :from AND :to
GROUP BY trigger_type
ORDER BY trigger_type;
```

**Caveats**:
- Latency includes any manual-approval hold time if `ORACLE_MANUAL_APPROVAL_ENABLED=true`;
  annotate approval gate usage in the report.


### KPI-3: Retry / Redrive Rate

**Definition**: Fraction of confirmed triggers that required more than one attempt, and
fraction that required a manual redrive from `EXHAUSTED_NEEDS_REDRIVE`.

**Formula**:
```
retry_rate   = (CONFIRMED triggers with attempt_count > 1 / total CONFIRMED) * 100
redrive_rate = (triggers that were ever EXHAUSTED_NEEDS_REDRIVE / total settled) * 100
```

**Baseline target**: retry_rate ≤ 20 %; redrive_rate ≤ 5 %.

**Data source**: `oracle_triggers`.

**Query**:
```sql
SELECT
    trigger_type,
    COUNT(*) FILTER (WHERE status = 'CONFIRMED')                                   AS confirmed,
    COUNT(*) FILTER (WHERE status = 'CONFIRMED' AND attempt_count > 1)             AS confirmed_with_retry,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'CONFIRMED' AND attempt_count > 1)
        / NULLIF(COUNT(*) FILTER (WHERE status = 'CONFIRMED'), 0), 2)               AS retry_rate_pct,
    ROUND(AVG(attempt_count) FILTER (WHERE status = 'CONFIRMED')::numeric, 2)      AS avg_attempts_confirmed,
    COUNT(*) FILTER (WHERE status = 'EXHAUSTED_NEEDS_REDRIVE')                     AS currently_exhausted,
    COUNT(*) FILTER (WHERE status IN ('CONFIRMED','TERMINAL_FAILURE','REJECTED'))  AS total_settled,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'EXHAUSTED_NEEDS_REDRIVE')
        / NULLIF(
            COUNT(*) FILTER (WHERE status IN (
                'CONFIRMED','TERMINAL_FAILURE','REJECTED','EXHAUSTED_NEEDS_REDRIVE'
            )), 0), 2)                                                              AS redrive_rate_pct
FROM oracle_triggers
WHERE created_at BETWEEN :from AND :to
GROUP BY trigger_type
ORDER BY trigger_type;
```


### KPI-4: Gas Profile

**Definition**: Observed on-chain transaction count by trigger type and error type distribution
for non-confirmed paths.

**Sub-metrics**:
- Total submitted transactions.
- Error type distribution for `FAILED` / `TERMINAL_FAILURE` triggers.
- Network vs. contract vs. validation error breakdown.

**Data source**: `oracle_triggers`.

**Query**:
```sql
SELECT
    trigger_type,
    status,
    error_type,
    COUNT(*) AS trigger_count,
    SUM(attempt_count) AS total_attempts
FROM oracle_triggers
WHERE created_at BETWEEN :from AND :to
GROUP BY trigger_type, status, error_type
ORDER BY trigger_type, status;
```

**Baseline notes**:
- Baseline gas observations from staging runs must be attached separately from
  Hardhat/Foundry test output (`contracts/coverage/` artifacts or CI logs).

**Caveats**:
- PolkaVM gas metering differs from EVM; use block explorer or RPC
  `eth_getTransactionReceipt.gasUsed` to obtain per-tx gas, then correlate by `tx_hash`.
  This template does not store gas units in the database; assert those values from the
  chain using on-chain evidence.


### KPI-5: Reconciliation Health (On-chain / Off-chain Parity)

**Definition**: Counts and severity breakdown of drift findings across the pilot window,
and the fraction of pilot trades that completed with zero CRITICAL drift.

**Sub-metrics**:
- `clean_trade_rate` — trades with zero CRITICAL/HIGH drift.

**Baseline target**: clean_trade_rate ≥ 98 %; zero recurring CRITICAL drifts for the same
`(trade_id, mismatch_code)` across more than two consecutive runs.

**Data source**: `reconcile_runs` + `reconcile_drifts` — `reconciliation/src/database/schema.sql`.

**Query A — run health summary** (includes `clean_trade_rate`):
```sql
WITH run_window AS (
    SELECT *
    FROM reconcile_runs
    WHERE started_at BETWEEN :from AND :to
),
dirty_trades AS (
    SELECT DISTINCT d.trade_id
    FROM reconcile_drifts d
    JOIN run_window r ON r.id = d.run_id
    WHERE d.severity IN ('CRITICAL', 'HIGH')
)
SELECT
    rw.status,
    COUNT(*)                                              AS run_count,
    SUM(rw.total_trades)                                  AS total_trades_checked,
    SUM(rw.drift_count)                                   AS total_drifts,
    SUM(rw.critical_count)                                AS total_critical,
    SUM(rw.high_count)                                    AS total_high,
    SUM(rw.medium_count)                                  AS total_medium,
    SUM(rw.low_count)                                     AS total_low,
    MIN(rw.started_at)                                    AS window_start,
    MAX(rw.completed_at)                                  AS window_end,
    COUNT(DISTINCT t.trade_id) FILTER (
        WHERE t.trade_id NOT IN (SELECT trade_id FROM dirty_trades)
    )                                                     AS clean_trades,
    ROUND(
        100.0 * COUNT(DISTINCT t.trade_id) FILTER (
            WHERE t.trade_id NOT IN (SELECT trade_id FROM dirty_trades)
        ) / NULLIF(COUNT(DISTINCT t.trade_id), 0), 2
    )                                                     AS clean_trade_rate_pct
FROM run_window rw
LEFT JOIN reconcile_drifts t ON t.run_id = rw.id
GROUP BY rw.status
ORDER BY rw.status;
```

**Query B — recurring CRITICAL drifts**:
```sql
SELECT
    d.trade_id,
    d.mismatch_code,
    d.compared_field,
    COUNT(DISTINCT r.id)   AS run_count,
    SUM(d.occurrences)     AS total_occurrences,
    MIN(r.started_at)      AS first_seen,
    MAX(r.started_at)      AS last_seen
FROM reconcile_drifts d
JOIN reconcile_runs r ON r.id = d.run_id
WHERE d.severity = 'CRITICAL'
  AND r.started_at BETWEEN :from AND :to
GROUP BY d.trade_id, d.mismatch_code, d.compared_field
HAVING COUNT(DISTINCT r.id) >= 2
ORDER BY run_count DESC, total_occurrences DESC;
```


## Section 2 — Report Structure

Fill one copy of this section per pilot window.

### 2.1 Header

| Field | Value |
|---|---|
| Pilot window  | `PILOT-<YYYY-MM-DD>` |
| Environment | `staging-e2e-real` / `mainnet` |
| Report generated at | `<timestamp>` |
| Operator | `<name / handle>` |
| Pilot Owner sign-off | `<name / handle>` |
| Chain ID | `<value>` |
| Escrow contract address | `<ORACLE_ESCROW_ADDRESS>` |
| Indexer GraphQL endpoint | `<ORACLE_INDEXER_GRAPHQL_URL>` |
| KPI query window (UTC) | `<from>` -> `<to>` |

### 2.2 KPI Summary Table

| KPI | Result | Target | Status |
|---|---|---|---|
| KPI-1 RELEASE_STAGE_1 success rate | `___%` | 100 % | PASS / FAIL |
| KPI-1 CONFIRM_ARRIVAL success rate | `___%` | 100 % | PASS / FAIL |
| KPI-1 FINALIZE_TRADE success rate | `___%` | 100 % | PASS / FAIL |
| KPI-2 RELEASE_STAGE_1 p50 latency | `___s` | ≤ 60 s | PASS / FAIL |
| KPI-2 RELEASE_STAGE_1 p95 latency | `___s` | ≤ 300 s | PASS / FAIL |
| KPI-2 CONFIRM_ARRIVAL p50 latency | `___s` | ≤ 60 s | PASS / FAIL |
| KPI-2 CONFIRM_ARRIVAL p95 latency | `___s` | ≤ 300 s | PASS / FAIL |
| KPI-2 FINALIZE_TRADE p50 latency | `___s` | ≤ 60 s | PASS / FAIL |
| KPI-2 FINALIZE_TRADE p95 latency | `___s` | ≤ 300 s | PASS / FAIL |
| KPI-3 retry rate | `___%` | ≤ 20 % | PASS / FAIL |
| KPI-3 redrive rate | `___%` | ≤ 5 % | PASS / FAIL |
| KPI-5 clean trade rate | `___%` | ≥ 98 % | PASS / FAIL |
| KPI-5 recurring CRITICAL drifts | `___` | 0 | PASS / FAIL |

### 2.3 Gas Profile Notes

Attach Hardhat/Foundry baseline output.

| Transaction type | Observed gas units | Baseline gas units | Delta % | Source |
|---|---|---|---|---|
| `createTrade` | | | | CI run / block explorer |
| `releaseFundsStage1` | | | | CI run / block explorer |
| `confirmArrival` | | | | CI run / block explorer |
| `finalizeAfterDisputeWindow` | | | | CI run / block explorer |

### 2.4 Narrative

#### Settlement Path
Describe the settlement lifecycle observed during the pilot window, noting any deviations
from the nominal two-stage flow described in `docs/runbooks/hybrid-split-walkthrough.md`.

#### Anomalies and Incidents
List any incident, escalations, or manual interventions.

#### Open Issues
List unresolved drift findings or trigger anomalies that require follow-up.


## Section 3 — Methodology and Reproducibility

### Data Collection Steps

1. Confirm pilot window boundaries (UTC):
   ```
   FROM:  <ISO timestamp>
   TO:    <ISO timestamp>
   ```

2. Run KPI queries in order against the Postgres instance used during the pilot.

3. Export query results as JSON or CSV and attach to this report document.

4. Capture chain evidence.

5. Run a final reconciliation snapshot.

6. Capture reconciliation run output.

### Report Reproducibility Guarantee
- All KPI queries are deterministic for a fixed `(from, to)` window against an
  immutable database snapshot.
- Preserve database snapshots or logical backups aligned to the pilot window for
  post auditing.


## Section 4 — Chain and Reconciliation Evidence Links

Attach the following artifacts to the report bundle.

### Chain Evidence
- Block explorer links for each `tx_hash` in `oracle_triggers.tx_hash` where
  `status = 'CONFIRMED'` during the pilot window.
- Indexer GraphQL query results (JSON) for `trades` and `tradeEvents` covering the
  pilot window (see Step 4 above).
- `ricardianHash` values per trade, cross-referenced to off-chain PDF contract digests.

### Reconciliation Evidence
- Raw output of the final `reconcile:once` run.
- `reconcile_runs` row for each run during the pilot window.
- `reconcile_drifts` rows for any CRITICAL or HIGH findings.
- Screenshot or log extract confirming zero unresolved CRITICAL drift at window close.

### Oracle Evidence
- Full KPI query outputs as produced by Steps 2–3.
- Operator notes for any manual redrive actions taken (`docs/runbooks/oracle-redrive.md` ref).
- Approval audit trail for triggers processed under `ORACLE_MANUAL_APPROVAL_ENABLED=true`.


## Section 5 — Acceptance Criteria Checklist

Before signing off on the pilot report:

- [ ] KPI-1 success rate 100 % for all three trigger types.
- [ ] KPI-2 p95 latency ≤ 300 s for all three trigger types.
- [ ] KPI-3 redrive rate ≤ 5 %.
- [ ] KPI-5 clean trade rate ≥ 98 %; zero recurring CRITICAL drifts.
- [ ] Gas profile attached and no material regression vs. baseline noted.
- [ ] All chain evidence links verified and accessible.
- [ ] All reconciliation evidence files attached.
- [ ] Any open anomalies have a documented follow-up issue reference.
- [ ] Pilot Owner has reviewed and signed off.


## Related Runbooks
- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/hybrid-split-walkthrough.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/treasury-to-fiat-sop.md`

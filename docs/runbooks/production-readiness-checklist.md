# Production Readiness Checklist

Purpose:

- Define deterministic go-live criteria for Cotsel production deployments.
- Provide a single source of truth for security, fee behavior, operations, and rollback readiness.

## 1) Security Prerequisites

### Secrets management

- No plaintext secrets in repository files, Docker images, CI logs, or artifacts.
- Runtime secrets must be injected through environment management and rotated on schedule.
- `.env*` templates must contain placeholders only.

### Access control

- Least privilege required for CI tokens, cloud credentials, database users, and service accounts.
- Protected branches require mandatory checks and peer review.
- Admin access to production infra/services is restricted and auditable.

### Dependency vulnerability posture

- Block release on known High/Critical production dependency vulnerabilities without an approved exception.
- Moderate/Low vulnerabilities require documented risk acceptance or remediation plan.
- `npm audit fix --force` is disallowed for release preparation.

### Audit and remediation gates

- Security findings must map to tracked issues with owner, severity, and due date.
- Release gate includes explicit verification that blocker findings are resolved or waived by policy owner.

### Compliance boundary governance (KYB/KYT/Sanctions)

- Compliance decision policy is defined in `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`.
- New trades must fail-closed when compliance provider state is unavailable/unknown.
- Emergency override requires documented approval by Compliance Lead + Incident Commander and is time-boxed to 24 hours.
- Compliance audit evidence retention is 7 years with immutable/append-only storage expectations.
- Provider outage escalation is enforced operationally: `HIGH` after 30 minutes, `CRITICAL` after 2 hours with release pause.

### Signing key custody and rotation

- Private key access is role-limited and logged.
- Emergency rotation procedure is documented and tested in non-production first.
- Shared test/dev keys are never reused for production environments.
- Gateway governance signer custody is defined in `docs/runbooks/gateway-governance-signer-custody.md`.
- Production governance execution must use managed signer custody; raw `GATEWAY_EXECUTOR_PRIVATE_KEY` env injection is staging-only unless a time-boxed exception is approved and rotated immediately after use.

## 2) Gas and Fee Expectations

### Baseline transaction expectations

- Core contract actions (`createTrade`, release/dispute milestones) have baseline gas observations documented from latest test/staging runs.
- Changes that materially increase gas costs require release-note justification and approval.

### Fee anomaly alerting

- Alert if observed fees exceed baseline thresholds for sustained periods.
- Alert if RPC fee estimation diverges significantly from executed fee outcomes.

### Fallback fee policy

- If fee thresholds are exceeded, operators must pause non-critical execution paths and run fallback review.
- Fallback decision outcomes must be logged: continue, delay, or rollback.

### RPC reliability assumptions

- Production requires redundant RPC endpoints or a documented failover strategy.
- Release readiness checks include RPC health, latency, and timeout behavior.

## 3) Operational Prerequisites

### Monitoring requirements

- Required visibility: service health endpoints, Postgres/Redis health, indexer lag, reconciliation drift summary, and RPC latency/errors.
- Dashboards must support quick triage for oracle, reconciliation, treasury, and indexer paths.

### Alerting and escalation

- Alerts route to on-call channel with severity mapping and primary/secondary responders.
- Escalation path includes defined ownership for app, data, and infrastructure incidents.

### Backup policy

- Postgres backups are scheduled, retained by policy, and restoration is periodically tested.
- Ricardian/legal document storage backup and restore path is documented and tested.
- Postgres recovery drill evidence is produced via `scripts/postgres-backup-restore-smoke.sh` and stored under `reports/postgres-recovery/`.

### Postgres recovery drill cadence

- Pilot cadence: run backup/restore smoke at least weekly and archive the generated JSON/log artifacts.
- Post-pilot cadence: run at least monthly and additionally after schema migrations with non-trivial risk.
- Runbook source of truth: `docs/runbooks/postgres-backup-restore-recovery.md`.

### Logging and correlation

- Structured logs include correlation identifiers (request ID, trade ID, tx hash where applicable).
- Logs must redact secrets and sensitive key material.
- Retention windows must satisfy operational and audit requirements.

### Operational SLOs

- Availability SLO is defined per critical service.
- Latency/error budget expectations are defined for API and reconciliation/oracle loops.
- Breach handling procedure (stabilize, mitigate, retrospective) is documented.

## 4) Rollback Gates

### Rollback triggers

- Trigger rollback on deterministic release-gate failure, critical runtime regressions, data integrity anomalies, or unresolved security blockers.

### Rollback procedure

- Stop affected profiles/services.
- Revert to last known-good deploy artifact and configuration.
- Re-run health and gate checks before reopening traffic.
- For Base mainnet launch governance and ordered rollback control, use:
  - `docs/runbooks/base-mainnet-go-no-go.md`
  - `docs/runbooks/base-mainnet-cutover-and-rollback.md`

### Data rollback policy

- Schema/database changes require reversible migration strategy or forward-fix plan approved before release.
- Data reconciliation steps must be documented for partial-failure scenarios.

### Safe mode and circuit breakers

- Emergency controls (pause paths / trigger disable modes) must be verified and documented before release.
- Operators must know exact commands/runbooks to place system in safe mode.

## Verification Before Marking Ready

- Node parity checks run under Node 20.
- Workspace validation passes: lint, typecheck, and tests.
- Profile checks pass for local and staging release-gate paths.
- Repo-local proof is not sufficient by itself for a production-candidate
  rehearsal claim. Record either:
  - a live rehearsal packet under `reports/base-sepolia-pilot-validation/<window-id>/`
  - or an explicit statement that only repo-local proof and config-only rehearsal
    have been completed
- Required runbooks are linked and up to date:
  - `docs/runbooks/runtime-truth-deployment-guide.md`
  - `docs/runbooks/service-auth-matrix.md`
  - `docs/runbooks/secrets-and-token-rotation.md`
  - `docs/runbooks/docker-profiles.md`
  - `docs/runbooks/postgres-backup-restore-recovery.md`
  - `docs/runbooks/postgres-service-roles-and-rls.md`
  - `docs/runbooks/staging-e2e-release-gate.md`
  - `docs/runbooks/staging-e2e-real-release-gate.md`
  - `docs/runbooks/base-mainnet-go-no-go.md`
  - `docs/runbooks/base-mainnet-cutover-and-rollback.md`
  - `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`
  - `docs/runbooks/gateway-governance-signer-custody.md`
  - `docs/runbooks/oracle-redrive.md`
  - `docs/incidents/first-15-minutes-checklist.md`

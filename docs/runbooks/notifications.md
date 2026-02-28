# Notifications Runbook

## Purpose
Operate deterministic alert delivery with bounded retries, cooldown deduplication, and explicit escalation routing.

## Source Of Truth
- Notification library: `notifications/src/index.ts`
- Runtime integrations:
  - `oracle/src/core/trigger-manager.ts`
  - `oracle/src/worker/confirmation-worker.ts`
  - `reconciliation/src/core/reconciler.ts`
- Runtime/profile gates:
  - `scripts/notifications-wiring-health.sh`
  - `scripts/notifications-gate.sh`
  - `scripts/notifications-gate-validate.mjs`

## Template And Severity Versioning
- Routing version constant: `NOTIFICATION_ROUTING_VERSION`
- Template version registry: `NOTIFICATION_TEMPLATE_VERSIONS`
- Fallback template version: `DEFAULT_TEMPLATE_VERSION`

Versioning strategy:
1. Add a new template version key instead of mutating existing version identifiers.
2. Update producer event `type` mapping only after template rollout is ready.
3. Keep prior version entry during rollout window to support safe rollback.

Severity route policy:
- `info` -> `informational`
- `warning` -> `operations`
- `critical` -> `pager`

## Retry, Cooldown, And Dedup Behavior
- Delivery attempts are bounded:
  - `retryAttempts` controls additional retries after the first attempt.
  - Hard cap is enforced in library code to prevent uncontrolled retry loops.
- Retry delays are bounded exponential backoff:
  - `retryDelayMs` base delay
  - `maxRetryDelayMs` cap
- Cooldown dedup:
  - same `dedupKey` within `cooldownMs` is suppressed
  - dedup marker is written only after successful delivery
- Restart limitation:
  - dedup cache is in-memory and process-local
  - restarts clear dedup state, so repeated events can send again

## Suppression Procedure
1. Confirm duplicate events share the same `dedupKey`.
2. Verify cooldown window (`cooldownMs`) is appropriate for the event type.
3. If noise persists, adjust event producer key strategy (do not disable critical notifications globally).
4. Re-run smoke notification and confirm suppression in logs.

## Escalation Procedure
Escalate by severity route:
- `informational`: ticket or async backlog follow-up.
- `operations`: on-call operations channel with 30-minute response target.
- `pager`: immediate paging and incident process start.

Capture evidence when escalating:
- event `type`, `severity`, `dedupKey`
- attempt count and webhook response status
- correlation fields (`tradeId`, `actionKey`, `requestId`, `txHash`, `runKey`)

## Rollback Procedure
1. Revert to previous known-good notifications package commit.
2. Restore prior template version mapping in `NOTIFICATION_TEMPLATE_VERSIONS`.
3. Re-run notifications tests and the deterministic gate probe:
   - `npm -w notifications run build`
   - `scripts/notifications-gate.sh staging-e2e-real`
4. Confirm no secrets are logged and retry bounds are still enforced.

## Runtime Health + Release Evidence
- Profile-level wiring health checks:
  - `scripts/docker-services.sh health local-dev`
  - `scripts/docker-services.sh health staging-e2e-real`
- Deterministic critical-path probe:
  - `scripts/notifications-gate.sh staging-e2e-real`
  - Report output: `reports/notifications/staging-e2e-real.json`
- CI evidence artifact:
  - `ci-report-notifications-gate` from `.github/workflows/release-gate.yml`
  - Contains deterministic probe output for:
    - `ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE`
    - `RECONCILIATION_CRITICAL_DRIFT`

## Safety Requirements
- Do not log webhook secrets, tokens, or full credentialed URLs.
- Keep retry attempts bounded.
- Keep dedup key stable and deterministic per event identity.

## Verification Commands
```bash
npm -w notifications test --if-present
npm -w notifications lint
npm -w notifications run build
scripts/notifications-gate.sh staging-e2e-real
```

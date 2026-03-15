# Incident Evidence Template

## Purpose
Provide a deterministic incident-closeout structure for settlement-adjacent failures, operator interventions, and automation containment events.

Use this template when a responder needs to preserve enough evidence to explain:
- what happened
- which trades or actions were affected
- what containment or rollback was chosen
- what service and on-chain truth supports the decision

## When To Use
- Oracle redrive incidents or repeated exhaustion paths.
- Reconciliation drift incidents or truth-source conflicts.
- Gateway mutation incidents or control-plane safety investigations.
- Treasury payout incidents that require containment, cancellation, or manual recovery.

## Current Correlation Baseline
Current mandatory log fields come from `docs/observability/logging-schema.md`:
- `tradeId`
- `actionKey`
- `requestId`
- `txHash`
- `traceId`

Populate the following when the service surface already provides them:
- `correlationId`
- `actor`
- `intent`
- `outcome`
- `blockNumber` / `extrinsicHash`
- incident or ticket reference

This template is forward-compatible with later audit-envelope standardization and should not be treated as permission to omit currently available evidence.

## Incident Summary

| Field | Value |
|---|---|
| Incident ID / ticket | `<id>` |
| Severity | `<SEV-1 / SEV-2 / SEV-3>` |
| Declared at (UTC) | `<timestamp>` |
| Incident commander | `<name>` |
| Primary service boundary | `<oracle / reconciliation / gateway / treasury / indexer / contracts>` |
| Customer or operator impact | `<summary>` |
| Current state | `<active / contained / monitoring / resolved>` |

## Affected Identifiers

Populate one row per impacted action or trade.

| Trade ID | Action Key | Request ID | Trace ID | Correlation ID | Tx Hash / Extrinsic | Actor | Intent | Outcome | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `<tradeId>` | `<actionKey>` | `<requestId>` | `<traceId>` | `<correlationId or N/A>` | `<txHash/extrinsicHash or N/A>` | `<actor or N/A>` | `<intent or N/A>` | `<outcome or pending>` | `<notes>` |

## Containment And Rollback Decision

| Decision time (UTC) | Action | Owner | Reason | Rollback / follow-up reference |
|---|---|---|---|---|
| `<timestamp>` | `<pauseClaims / disable mutation / stop daemon / continue monitoring>` | `<owner>` | `<reason>` | `<runbook / command / PR / ticket>` |

## Evidence Sources

| Source type | Artifact / query | Location | Captured by | Timestamp (UTC) |
|---|---|---|---|---|
| Service health | `<command or endpoint>` | `<path or URL>` | `<owner>` | `<timestamp>` |
| Service logs | `<oracle/reconciliation/gateway/treasury logs>` | `<artifact path>` | `<owner>` | `<timestamp>` |
| Chain truth | `<explorer URL / cast call output>` | `<artifact path or URL>` | `<owner>` | `<timestamp>` |
| Indexer / DB truth | `<query / report>` | `<artifact path>` | `<owner>` | `<timestamp>` |
| Incident chat / ticket | `<ticket URL>` | `<URL>` | `<owner>` | `<timestamp>` |

## Timeline

| Time (UTC) | Event | Evidence ref |
|---|---|---|
| `<timestamp>` | `<event>` | `<artifact / requestId / txHash>` |

## Closeout Checklist
- [ ] Severity, owner, and impact recorded.
- [ ] Affected `tradeId` / `actionKey` / `requestId` values captured where applicable.
- [ ] `traceId` and `txHash` or equivalent chain references captured where available.
- [ ] Containment or rollback decision recorded with timestamp and owner.
- [ ] Evidence artifacts linked for service logs, chain truth, and indexer or DB truth.
- [ ] Follow-up PRs, tickets, or hotfix references linked before incident closure.

## Related Runbooks
- `docs/incidents/first-15-minutes-checklist.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/dashboard-gateway-operations.md`
- `docs/runbooks/operator-audit-evidence-template.md`

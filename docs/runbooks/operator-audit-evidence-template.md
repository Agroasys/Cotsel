# Operator Audit Evidence Template

## Purpose
Provide a deterministic evidence format for operator-reviewed actions across gateway, oracle, reconciliation, and treasury workflows.

Use this template when an operator needs an audit-ready package for:
- control-plane approvals or rejections
- reconciliation investigations
- manual redrive or recovery actions
- treasury payout reviews and exception handling

## Evidence Field Rules
Current mandatory audit-envelope fields come from `docs/observability/logging-schema.md`:
- `tradeId`
- `actionKey`
- `requestId`
- `correlationId`
- `txHash`
- `traceId`
- `intent`
- `outcome`

Additional fields should be populated when available from the service boundary:
- `actor`
- `blockNumber`
- `logIndex`
- approval or ticket reference

If a field is not available for the workflow, record `N/A` instead of leaving it blank.
If the runtime logger does not emit a field directly, source it from the nearest
authoritative gateway ledger, request record, or operator evidence source.

## Audit Packet Header

| Field | Value |
|---|---|
| Packet ID | `<id>` |
| Workflow | `<gateway governance / oracle redrive / reconciliation / treasury payout / other>` |
| Prepared by | `<name>` |
| Reviewed by | `<name>` |
| Generated at (UTC) | `<timestamp>` |
| Environment | `<local-dev / staging-e2e-real / pilot / production>` |
| Incident / ticket reference | `<URL or id>` |

## Core Evidence Table

| Trade ID | Action Key | Request ID | Trace ID | Correlation ID | Actor | Intent | Outcome | Tx Hash | Service | Evidence link |
|---|---|---|---|---|---|---|---|---|---|---|
| `<tradeId or N/A>` | `<actionKey or N/A>` | `<requestId or N/A>` | `<traceId or N/A>` | `<correlationId or N/A>` | `<actor or N/A>` | `<intent or N/A>` | `<outcome or pending>` | `<txHash or N/A>` | `<service>` | `<path or URL>` |

## Supporting Artifacts

| Artifact type | Required contents | Location |
|---|---|---|
| Service logs | Correlation fields, normalized outcome, timestamps | `<path>` |
| API or queue record | Request payload summary, status transitions, actor context | `<path>` |
| Chain truth | Explorer URL, call output, or event snapshot | `<path or URL>` |
| Reconciliation or indexer output | Report rows or query output proving state alignment | `<path>` |
| Approval evidence | Reviewer names, timestamps, ticket links | `<path or URL>` |

## Operator Sign-Off

| Reviewer | Decision | Timestamp (UTC) | Notes |
|---|---|---|---|
| `<name>` | `<approved / rejected / requires follow-up>` | `<timestamp>` | `<notes>` |

## Closeout Checklist
- [ ] Core `AuditEnvelopeV1` fields captured from current logging or ledger baseline.
- [ ] `actor`, `intent`, and `outcome` populated from the authoritative service or ledger source.
- [ ] On-chain transaction reference attached where a state-changing action occurred.
- [ ] Approval or escalation references attached.
- [ ] Links to service logs and supporting artifacts included.

## Related Runbooks
- `docs/observability/logging-schema.md`
- `docs/incidents/incident-evidence-template.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/dashboard-gateway-operations.md`

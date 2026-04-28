# Production-Sensitive Action Evidence Index

Snapshot date: 2026-04-28

## Purpose

Provide one operator-facing index for sensitive production actions and the
evidence that must exist before, during, and after execution. This does not add a
new workflow engine. It links the existing runbooks and evidence templates so a
future reviewer can answer what happened, who approved it, which runbook applied,
and where the proof lives.

## Evidence Rule

For every action class below, the operator packet must include:

- incident, change, or ticket reference
- named actor and approver role
- applied runbook
- request/correlation identifiers
- before/after state or chain truth
- failure/rollback decision when relevant
- evidence storage location

If a field is unavailable, write `N/A` and name the authoritative source that
does not emit it yet. Do not leave blanks.

## Action Classes

| Action class                         | Examples                                                         | Required runbook                                                                      | Required evidence packet                                      | Required approver roles                                        |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Base mainnet launch/cutover          | Runtime promotion, mainnet deployment, rollback decision         | `docs/runbooks/base-mainnet-go-no-go.md`                                              | Launch approval record plus staging/mainnet validation links  | Engineering Lead, Ops Lead, Treasury Owner, Incident Commander |
| Mainnet contract deployment/verify   | `deploy:base-mainnet`, `verify:base-mainnet`                     | `docs/runbooks/base-mainnet-go-no-go.md`                                              | Deployment tx, verify output, chain ID, contract address      | Engineering Lead, Ops Lead                                     |
| Human privileged governance signing  | Gateway prepare/confirm admin action                             | `docs/runbooks/gateway-governance-signer-custody.md`                                  | Gateway action ID, signer address, tx hash, approval record   | Service Owner plus peer reviewer                               |
| Delegated executor governance action | `npm run -w gateway execute:governance-action -- <actionId>`     | `docs/runbooks/gateway-governance-signer-custody.md`                                  | Executor session window, signer custody source, tx hash       | Service Owner plus peer reviewer                               |
| Emergency disable/break-glass        | Pause, emergency containment, unpause planning                   | `docs/runbooks/emergency-disable-unpause.md`                                          | Incident packet plus break-glass reason and post-action proof | Incident Commander plus Service Owner                          |
| Oracle manual approval/redrive       | Trigger approve/reject, one controlled redrive                   | `docs/runbooks/oracle-redrive.md`                                                     | Redrive acceptance checklist, trigger row, on-chain state     | On-call Engineer plus Service Owner for repeated failure       |
| Treasury sweep approval/execution    | Sweep batch approval, execution match, close                     | `docs/runbooks/treasury-to-fiat-sop.md` and `docs/runbooks/treasury-revenue-close.md` | Sweep batch trace, accounting period, signer/audit metadata   | Treasury Approver plus Treasury Operator                       |
| External treasury handoff            | Bridge/provider handoff, bank confirmation, exception resolution | `docs/runbooks/treasury-to-fiat-sop.md`                                               | Partner reference, payout state history, bank evidence        | Treasury Approver plus Compliance Reviewer when needed         |
| Reconciliation drift remediation     | Drift investigation, report closeout, manual exception           | `docs/runbooks/reconciliation.md`                                                     | Reconciliation report, affected trades, resolution decision   | Reconciliation owner plus On-call Engineer                     |
| Compliance override                  | Time-boxed KYB/KYT/sanctions override                            | `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`                              | Override reason, expiry, actor, review timestamp              | Compliance Lead plus Incident Commander                        |
| Secret rotation                      | API key, service-auth key, signer exception cleanup              | `docs/runbooks/secrets-and-token-rotation.md`                                         | Old/new key reference, rotation timestamp, validation output  | Ops Lead plus Security owner                                   |

## Storage Convention

- Incident-driven actions: attach the completed packet to the incident record and
  use `docs/incidents/incident-evidence-template.md`.
- Change-driven production actions: attach the completed packet to the change or
  launch ticket.
- Operator-reviewed non-incident actions: use
  `docs/runbooks/operator-audit-evidence-template.md`.
- Repo-local rehearsal evidence should live under `reports/` with a stable
  window/run key when the runbook already defines one.

## Minimal Evidence Record

Use this table in the ticket, incident, or launch record for any action class in
this index.

| Field                         | Value                            |
| ----------------------------- | -------------------------------- |
| Action class                  | `<one row from Action Classes>`  |
| Environment                   | `<staging / production / pilot>` |
| Incident/change/ticket        | `<URL or id>`                    |
| Applied runbook               | `<path or URL>`                  |
| Operator / actor              | `<name or service id>`           |
| Approver role(s)              | `<roles>`                        |
| Request ID                    | `<id or N/A>`                    |
| Correlation ID                | `<id or N/A>`                    |
| Trade/action/batch identifier | `<id or N/A>`                    |
| Before state                  | `<state / hash / balance / N/A>` |
| After state                   | `<state / hash / balance / N/A>` |
| Tx hash / external reference  | `<hash / provider ref / N/A>`    |
| Validation command/output     | `<path or summary>`              |
| Rollback or follow-up state   | `<not needed / linked item>`     |
| Evidence storage location     | `<path or URL>`                  |

## Non-Goals

- No evidence requirement for trivial local development actions.
- No replacement for external production deployment/change-control systems.
- No fake proof when live evidence has not been generated.
- No new compliance theater beyond genuinely sensitive production controls.

# Dashboard Gateway Route Inventory

Last reviewed: 2026-06-09

This inventory is the first cleanup gate for the Cotsel dashboard gateway. It maps routes observed
from the canonical `Agroasys/Cotsel.dash` connected adapters to Cotsel route modules. Do not remove
routes from Cotsel only because they are absent from this static scan. A route is eligible for
removal only after gateway access logs, contract tests, and dashboard live parity prove it is dead.

## Source of Truth

- Dashboard usage source: `Agroasys/Cotsel.dash` `src/lib/api/*` adapter paths.
- Gateway source: `gateway/src/routes/*`.
- Auth source: `auth/src/api/routes.ts`.
- Parity coverage: `Dashboard Live Parity` plus `Cotsel.dash` mocked e2e responsive coverage.

## Observed Dashboard Gateway Reads

| Route                                                     | Cotsel module                          | Dashboard adapter          |
| --------------------------------------------------------- | -------------------------------------- | -------------------------- |
| `GET /auth/capabilities`                                  | `gateway/src/routes/capabilities.ts`   | `operator-capabilities.ts` |
| `GET /overview`                                           | `gateway/src/routes/overview.ts`       | `overview.ts`              |
| `GET /operations/summary`                                 | `gateway/src/routes/operations.ts`     | `operations.ts`            |
| `GET /trades`                                             | `gateway/src/routes/trades.ts`         | `trades.ts`                |
| `GET /trades/:tradeId`                                    | `gateway/src/routes/trades.ts`         | `trades.ts`                |
| `GET /reconciliation`                                     | `gateway/src/routes/reconciliation.ts` | `reconciliation.ts`        |
| `GET /reconciliation/handoffs/:handoffId`                 | `gateway/src/routes/reconciliation.ts` | `reconciliation.ts`        |
| `GET /treasury`                                           | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/actions`                                   | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/accounting-periods`                        | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/accounting-periods/:periodId/close-packet` | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/accounting-periods/:periodId/rollforward`  | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/entries/accounting`                        | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/entries/:entryId/accounting`               | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/sweep-batches`                             | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/sweep-batches/:batchId`                    | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /treasury/sweep-batches/:batchId/trace`              | `gateway/src/routes/treasury.ts`       | `treasury.ts`              |
| `GET /compliance/trades/:tradeId`                         | `gateway/src/routes/compliance.ts`     | `compliance.ts`            |
| `GET /compliance/trades/:tradeId/attestation-status`      | `gateway/src/routes/compliance.ts`     | `compliance.ts`            |
| `GET /compliance/trades/:tradeId/decisions`               | `gateway/src/routes/compliance.ts`     | `compliance.ts`            |
| `GET /compliance/decisions/:decisionId`                   | `gateway/src/routes/compliance.ts`     | `compliance.ts`            |
| `GET /governance/status`                                  | `gateway/src/routes/governance.ts`     | `governance.ts`            |
| `GET /governance/actions`                                 | `gateway/src/routes/governance.ts`     | `governance.ts`            |
| `GET /governance/actions/:actionId`                       | `gateway/src/routes/governance.ts`     | `governance.ts`            |
| `GET /settings/role-assignments`                          | `gateway/src/routes/settings.ts`       | `settings.ts`              |
| `GET /settings/audit-feed`                                | `gateway/src/routes/settings.ts`       | `settings.ts`              |
| `GET /access-logs`                                        | `gateway/src/routes/accessLogs.ts`     | `accessLogs.ts`            |
| `GET /access-logs/:entryId`                               | `gateway/src/routes/accessLogs.ts`     | `accessLogs.ts`            |
| `GET /approvals`                                          | `gateway/src/routes/approvals.ts`      | `approval-workflow.ts`     |
| `GET /approvals/:approvalId`                              | `gateway/src/routes/approvals.ts`      | `approval-workflow.ts`     |
| `GET /ricardian/:tradeId`                                 | `gateway/src/routes/ricardian.ts`      | `ricardian.ts`             |
| `GET /evidence/:tradeId`                                  | `gateway/src/routes/ricardian.ts`      | `evidence.ts`              |

## Observed Dashboard Gateway Mutations

| Route                                                        | Cotsel module                               | Dashboard adapter         |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------- |
| `POST /access-logs`                                          | `gateway/src/routes/accessLogs.ts`          | `accessLogs.ts`           |
| `POST /evidence/bundles`                                     | `gateway/src/routes/evidenceBundles.ts`     | `evidence.ts`             |
| `POST /compliance/decisions`                                 | `gateway/src/routes/compliance.ts`          | `compliance.ts`           |
| `POST /compliance/trades/:tradeId/block-oracle-progression`  | `gateway/src/routes/compliance.ts`          | `compliance.ts`           |
| `POST /compliance/trades/:tradeId/resume-oracle-progression` | `gateway/src/routes/compliance.ts`          | `compliance.ts`           |
| ~~Governance direct-sign mutation routes~~                   | ~~Removed in PR #567~~                      | ~~`governance.ts`~~       |
| `POST /treasury/sweep-batches/:batchId/approve`              | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/accounting-periods/:periodId/close`          | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/sweep-batches/:batchId/close`                | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/entries/:entryId/realizations`               | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/sweep-batches/:batchId/match-execution`      | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/sweep-batches/:batchId/external-handoff`     | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/accounting-periods/:periodId/request-close`  | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /treasury/sweep-batches/:batchId/request-approval`     | `gateway/src/routes/treasury.ts`            | `treasury.ts`             |
| `POST /dashboard-settlement/gasless-executions/create-trade` | `gateway/src/routes/dashboardSettlement.ts` | `settlement-execution.ts` |

## Auth Service Routes Used By Cotsel.dash

These routes are not under `VITE_API_DASHBOARD_GATEWAY_BASE_URL`; they are under the Cotsel auth
base URL.

| Route                   | Cotsel module            | Dashboard adapter |
| ----------------------- | ------------------------ | ----------------- |
| `GET /session`          | `auth/src/api/routes.ts` | `auth-session.ts` |
| `POST /session/refresh` | `auth/src/api/routes.ts` | `auth-session.ts` |
| `POST /session/revoke`  | `auth/src/api/routes.ts` | `auth-session.ts` |

The trusted platform exchange route `POST /session/exchange/agroasys` is required for the
Agroasys-backend-issued session model even though it is not directly called by browser code.

## Keep Until Proven Dead

The following surfaces are not safe cleanup candidates from static dashboard usage alone:

- `GET /healthz`, `GET /readyz`, and `GET /version`: used by operations, release gates, and live
  parity health checks.
- `GET /operations`, `GET /operations/gasless-relayer/readiness`,
  `GET /operations/failed-operations`, `GET /operations/failed-operations/:failedOperationId`,
  and failed-operation redrive routes: operational runbooks reference these surfaces.
- `GET /evidence/bundles`, `GET /evidence/bundles/:bundleId`, and
  `GET /evidence/bundles/:bundleId/download`: evidence bundle lifecycle routes are implemented in
  Cotsel even though the current dashboard adapter only creates bundles.
- Legacy non-`/prepare` governance mutation routes in `gateway/src/routes/governanceMutations.ts`:
  these look like retirement candidates, but they must remain until contract tests, access logs,
  and migration notes prove no clients use them.
- Settlement handoff routes under `gateway/src/routes/settlement.ts`: they are platform/service
  integration routes, not dashboard UI routes, so dashboard absence is not evidence of dead code.

## Cleanup Rule

Gateway cleanup should proceed in three separate PRs:

1. Add or refresh route inventory and live parity coverage.
2. Mark suspected dead routes as deprecated with tests proving the intended replacement.
3. Remove routes only after production or staging access logs show no traffic for the agreed window
   and contract tests prove no supported client depends on them.

# ADR-0411: Supersede Queued Executor as Default for Human Privileged Governance — Adopt Direct Admin Wallet Signing

- Status: Accepted
- Date: 2026-04-05
- Related issue: [#411](https://github.com/Agroasys/Cotsel/issues/411)
- Supersedes: [Decision: Dashboard gateway governance signing model #215](https://github.com/Agroasys/Cotsel/issues/215)

## Context

The queued gateway + executor signer model was approved under issue #215 as a workable pilot and compatibility arrangement. It routes human-initiated privileged governance actions through a backend queue, then executes them with an executor signer key (`GATEWAY_EXECUTOR_PRIVATE_KEY`) held by the gateway process.

This design is no longer the long-term target for human-privileged governance. Three repo-grounded incompatibilities establish this:

1. `gateway/src/routes/governanceMutations.ts` accepts privileged human governance requests into a queue instead of preparing a direct-sign flow.
2. `gateway/src/executor/governanceExecutor.ts` enforces that the executor signer matches the queued approver wallet for approval actions, conflating human approval identity with a machine-held key.
3. `docs/runbooks/gateway-governance-signer-custody.md` and `docs/api/cotsel-dashboard-gateway.openapi.yml` treat the queued executor as the governance execution boundary, making executor signing appear to be the intended steady-state.

## Decision

**Human privileged governance actions must migrate to a direct admin wallet signing model.**

The backend gateway continues to play a role, it authenticates the operator session, prepares the canonical action payload, validates pre-flight state, records audit intent, and captures post-broadcast monitoring and evidence. But the signing and broadcast step must originate from the authenticated admin wallet, not from a backend executor key.

**Delegated/service execution remains executor-backed** for roles and operations that are intentionally automated. The executor model is correct for those paths and must not be dismantled.

## Action Classification

### Governance actions

Every governance action is signed directly by the admin wallet.

| Action | Contract method |
|---|---|
| Protocol pause | `pause` |
| Unpause proposal | `proposeUnpause` |
| Unpause approval | `approveUnpause` |
| Unpause proposal cancel | `cancelUnpauseProposal` |
| Claims pause | `pauseClaims` |
| Claims unpause | `unpauseClaims` |
| Treasury sweep | `claimTreasury` |
| Treasury payout receiver proposal | `proposeTreasuryPayoutAddressUpdate` |
| Treasury payout receiver approval | `approveTreasuryPayoutAddressUpdate` |
| Treasury payout receiver execute | `executeTreasuryPayoutAddressUpdate` |
| Treasury payout receiver cancel expired | `cancelExpiredTreasuryPayoutAddressUpdateProposal` |
| Oracle disable emergency | `disableOracleEmergency` |
| Oracle update proposal | `proposeOracleUpdate` |
| Oracle update approval | `approveOracleUpdate` |
| Oracle update execute | `executeOracleUpdate` |
| Oracle update cancel expired | `cancelExpiredOracleUpdateProposal` |

### Non-governance service roles — executor-backed (separate concern, not governance)

The executor model is retained only for service-owned automated roles. These are not governance actions and are out of scope for this ADR.

| Role | Operations |
|---|---|
| Oracle service | Stage releases, arrival confirmations, finalizations |
| Automated maintenance runners | Service-triggered background operations |

## Target Architecture

### Session and signing model

Agroasys auth is the identity and session layer for all operator roles. The wallet is action-scoped, not session-scoped.

- **Regular users** — session-first; the chain layer is invisible by design.
- **Operators** — session-first; work through evidence, workflow, and monitoring surfaces. No wallet friction for read-only or non-signing workflows.
- **Admins** — session-first for login and navigation; explicit wallet signing surfaces only when a privileged governance action requires on-chain authorization. This is the only class where signing friction is acceptable and expected.

Session bootstrap must read as normal login and session handling, not as "connect wallet to access dashboard." Governance workflows must read as prepare -> review -> sign -> monitor, not as queue -> executor.

### Flow

```
Admin (browser)
   │
   ├── Step 1: Login via Agroasys auth session (no wallet friction yet)
   │
   ├── Step 2: Navigate to governance action in dashboard
   │
   ▼
Gateway (prepare phase)
   │  ├── Validate operator session + write-access
   │  ├── Step-up auth challenge if required (Phase 3)
   │  ├── Validate pre-flight state (paused, proposal existence, quorum, timelock)
   │  ├── Build canonical action payload (contract address, calldata, chain ID, nonce)
   │  └── Record audit intent (actor wallet, action category, idempotency key)
   │
   ▼
Gateway response: { payload, txRequest }   ← prepared; not yet signed or broadcast
   │
   ├── Step 3: Admin reviews action details in dashboard (wallet not yet involved)
   │
   ▼
Admin wallet (MetaMask / Rabby / hardware wallet)
   │  └── Step 4: Admin signs and broadcasts, wallet appears only at this step
   │
   ▼
Chain (Base / Base Sepolia)
   │
   ▼
Gateway (monitor phase)
   │  ├── Receive txHash from dashboard post-broadcast
   │  ├── Confirm on-chain inclusion and finality
   │  ├── Update action record with txHash, blockNumber, final status
   │  └── Emit audit evidence (reconciliation, evidence capture)
```

The gateway retains its role as the trusted orchestration backend. It moves from signing agent to payload preparer and post-broadcast monitor. Blockchain details (chain IDs, RPCs, gas, raw tx parameters) are operational internals, they must not dominate the admin UX and should appear only where operationally useful.

## Alternatives Considered

### A) Keep queued executor with enforced signer match (current model, rejected for human governance)
- Pros: simpler dashboard integration; no frontend wallet-sign flow required.
- Cons: backend process holds admin key material; human approval identity is mediated by a machine key rather than the approving wallet signing directly; does not meet audit requirements for multi-admin governance.


### B) Direct wallet signing for human governance + retain executor for service roles (chosen)
- Pros: satisfies audit requirements for human governance; preserves intentional delegation for service roles; aligns signing identity with approver identity for on-chain approval methods.
- Cons: requires phased migration across gateway, dashboard, auth/step-up, and runbooks.

## Risk Analysis

### Transition period

The queued executor remains deployed during migration but is being narrowed in scope to delegated/service roles only. Human governance actions move to the direct-sign prepare -> review -> sign -> monitor path as each phase ships. The executor is not a fallback for human governance actions during or after migration; it is being restricted to service roles.

### Wallet availability

Direct wallet signing requires the operator wallet to be available and connected at execution time. Hardware wallet must be confirmed before any emergency governance action.

Mitigation:
- Emergency runbooks must be updated to include wallet availability as a pre-execution check.
- Step-up auth (Phase 3) adds an additional confirmation layer before the payload is prepared.

### Dashboard signing integration

The dashboard must implement wallet-connect governance signing. Until Phase 2 is complete, human operators using the dashboard cannot use the new flow.

Mitigation:
- Gateway prepare endpoint ships first and can be tested independently via CLI/SDK before the dashboard integration lands.


### Superseded decision
- [Decision: Dashboard gateway governance signing model #215](https://github.com/Agroasys/Cotsel/issues/215)

### Repo surfaces that must be updated in migration phases
- `gateway/src/routes/governanceMutations.ts` — queue endpoints to be supplemented with prepare endpoints (Phase 1)
- `gateway/src/executor/governanceExecutor.ts` — executor scope to be restricted to service roles (Phase 1)
- `docs/runbooks/gateway-governance-signer-custody.md` — transitional notice added now; full update in Phase 4
- `docs/api/cotsel-dashboard-gateway.openapi.yml` — description updated now; prepare endpoint schemas in Phase 1/4
- `docs/runbooks/architecture-coverage-matrix.md` — row added for this decision

### Related decisions and issues
- [#215](https://github.com/Agroasys/Cotsel/issues/215) — superseded by this ADR (anchored; no longer treated as forward direction)
- [#412](https://github.com/Agroasys/Cotsel/issues/412) — Phase 1 gateway implementation (prepare + confirm endpoints)
- [Cotsel-Dash #137](https://github.com/Agroasys/Cotsel-Dash/issues/137) — Phase 2 dashboard governance signing migration
- [Cotsel-Dash #139](https://github.com/Agroasys/Cotsel-Dash/issues/139) — Phase 2 dashboard governance signing migration
- [#123](https://github.com/Agroasys/Cotsel/issues/123) — API gateway runtime orchestration (related)

## Rollback

This ADR records a target architecture decision, not a completed migration. Rollback of the decision itself requires a new superseding ADR with explicit rationale. Any rollback must update the architecture coverage matrix, restore the superseded status on #215, and supersede this ADR explicitly. The executor model for service/delegated roles is unaffected by any rollback of this ADR.

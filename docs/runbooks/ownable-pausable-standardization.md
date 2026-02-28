# Ownable/Pausable Standardization Decision (#143)

## Context

`AgroasysEscrow` currently uses a custom multi-admin governance model (`isAdmin`, quorum approvals, proposal TTL/timelock) plus a custom pause flag/modifier.

- Contract: `contracts/src/AgroasysEscrow.sol`
- Existing admin quorum and governance controls are protocol-critical and already test-covered.

## Decision

Adopt **OpenZeppelin `Pausable`** for pause state and pause modifiers, and **retain custom multi-admin governance** as-is.

- Adopted now:
  - `Pausable` state + `_pause()` / `_unpause()` primitives
  - inherited `paused()` getter
- Retained (no Ownable migration):
  - `onlyAdmin` multi-admin model
  - dispute governance approvals
  - oracle/admin timelock proposal flows

Rationale:
- This provides standards-based pause internals with minimal protocol behavior change.
- Migrating to `Ownable`/`Ownable2Step` would collapse or complicate current quorum governance, increasing role-regression risk.

## Control Path Mapping

| Current control path | Location | Decision | Result |
|---|---|---|---|
| Admin auth (`onlyAdmin`) | `AgroasysEscrow.sol` | Retain custom | Quorum governance unchanged |
| Oracle auth (`onlyOracle`, `onlyOracleActive`) | `AgroasysEscrow.sol` | Retain custom | Oracle safety semantics unchanged |
| Pause storage + guard | `paused` bool + custom `whenNotPaused` | Replace with OZ `Pausable` | Standardized pause internals |
| Pause trigger | `pause()` | Keep admin entrypoint; call `_pause()` | Behavior equivalent |
| Unpause with approvals | `proposeUnpause/approveUnpause/_executeUnpause` | Keep flow; call `_unpause()` in execute | Quorum unpause retained |
| Emergency oracle disable | `disableOracleEmergency()` | Keep flow; use `_pause()` if needed | Emergency behavior preserved |
| Timeout payout/cancel escape hatches | `cancelLockedTradeAfterTimeout`, `refundInTransitAfterTimeout` | Add pause gating | Pause now blocks all state-mutating transfer paths |

## Security Regression Analysis

- Admin/oracle/dispute governance paths remain custom and unchanged in authority model.
- Pause behavior is standardized through OZ internals, reducing custom pause-state risk.
- Timeout payout/cancel functions are now pause-gated to align with emergency containment expectations.
- Governance recovery paths remain available while paused (`oracle/admin proposal/approve/execute/cancel` are not pause-gated).

## Migration Impact

- Runtime behavior change:
  - Paused state now blocks timeout cancel/refund user paths.
- Storage/layout:
  - Pause flag now comes from inherited `Pausable` storage (`_paused`) instead of local `paused` variable.
  - Current deployment model is non-upgradeable in-repo; this is safe for new deployments.
  - If future proxy upgrades are introduced, explicit storage layout review is required before migration.

## Rollback

- Revert the #143 PR commit(s) to restore prior custom pause implementation and timeout escape-hatch pause behavior.

## Follow-up Scope

- No additional Ownable migration is recommended in this change set.
- If ownership simplification is desired later, open a dedicated issue to model quorum-preserving ownership semantics before implementation.

# Emergency Disable / Unpause Runbook

## Purpose

Operational playbook for emergency stop and controlled recovery path.

Automation-governance source of truth:

- `docs/runbooks/programmability-governance.md`

Signer custody source of truth:

- `docs/runbooks/gateway-governance-signer-custody.md`

## Preconditions

- Incident severity confirmed (security or correctness risk).
- Admin quorum availability confirmed.
- Incident channel and audit recording active.

## Commands

- Contract interactions must be executed through approved admin tooling and governance flow.
- Do not execute ad-hoc scripts outside approved signer path.
- Emergency disable may use a break-glass signer session only under the custody and evidence rules in `docs/runbooks/gateway-governance-signer-custody.md`.

## Expected outputs

- Emergency disable action emits audit events.
- Unpause requires quorum/governance sequence, not a single-key shortcut.

## Common failure patterns

- Attempting recovery before root cause containment.
- Partial recovery without oracle reactivation governance.

## First 15 Minutes Checklist

- Execute `docs/incidents/first-15-minutes-checklist.md`.
- Confirm containment actions are complete before any recovery action.
- Verify reconciliation drift is stable before unpause proposal execution.

## Rollback / backout

1. Keep protocol paused if verification is incomplete.
2. Re-run reconciliation to verify state consistency before unpause.
3. Resume only after governance approvals are finalized.
4. Rotate or revoke any temporary break-glass signer session before reopening normal execution.

## Escalation criteria

- Suspected key compromise.
- Unexpected privileged-path behavior.
- Any mismatch between governance events and expected admin quorum.
- Any automation path that cannot be correlated to an approved change record or incident ticket.

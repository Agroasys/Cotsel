# Base Mainnet Cutover and Rollback

## Purpose and scope

Define the canonical operator sequence for Base mainnet cutover, rollback, and containment.

This runbook covers:

- preconditions before cutover starts
- ordered cutover steps
- rollback triggers and ordered rollback steps
- containment posture when rollback is partial or blocked
- role-based ownership during the launch window

This runbook does not cover:

- protocol feature delivery
- ad hoc deployment commands outside the approved change record
- reactivating retired settlement runtimes during rollback

## Authoritative references

- Launch approval record: `docs/runbooks/base-mainnet-go-no-go.md`
- Production readiness baseline: `docs/runbooks/production-readiness-checklist.md`
- Staging real validation: `docs/runbooks/staging-e2e-real-release-gate.md`
- Incident triage baseline: `docs/incidents/first-15-minutes-checklist.md`
- Emergency disable/unpause controls: `docs/runbooks/emergency-disable-unpause.md`
- Signer custody controls: `docs/runbooks/gateway-governance-signer-custody.md`
- Gateway operator boundary: `docs/runbooks/dashboard-gateway-operations.md`
- Reconciliation evidence generation: `docs/runbooks/reconciliation.md`

## Launch-day ownership matrix

Use roles, not personal names, in the canonical path:

| Responsibility                                    | Owner role           |
| ------------------------------------------------- | -------------------- |
| Launch approval authority                         | `Engineering Lead`   |
| Runtime promotion execution                       | `Ops Lead`           |
| Treasury and reconciliation verification          | `Treasury Owner`     |
| Incident declaration and containment coordination | `Incident Commander` |
| Provider escalation coordination                  | `Ops Lead`           |
| Communications update owner                       | `Incident Commander` |

## Preconditions before cutover begins

All of the following must be true before step 1 starts:

- `docs/runbooks/base-mainnet-go-no-go.md` approval record is present and marked `GO`
- M4 is complete in GitHub state
- retired runtime references have been removed from active CI, API, and runbook surfaces
- the production change record or external deployment record is attached
- current escrow address, chain ID `8453`, and Base mainnet USDC address are recorded
- signer custody review is complete
- provider primary and fallback posture is recorded
- rollback owner and communications owner are assigned

## Cutover steps

Execute these steps in order. If any step fails, stop and evaluate rollback triggers.

1. Freeze the approval packet.
   - Record the final go/no-go timestamp and launch window ID.
   - Record the deployment/change record that will perform runtime promotion.

2. Reconfirm current staging-real evidence.
   - Run:
     ```bash
     scripts/validate-env.sh staging-e2e-real
     scripts/docker-services.sh health staging-e2e-real
     scripts/staging-e2e-real-gate.sh
     scripts/notifications-gate.sh staging-e2e-real
     npm run -w reconciliation reconcile:report -- --run-key=<runKey> --out reports/reconciliation/<file>.json
     ```
   - If any required check fails, stop and mark the window `NO-GO`.

3. Verify deployment truth for the launch window.
   - If mainnet deployment is part of the launch window, execute only the approved repo command path:
     ```bash
     npm run -w contracts deploy:base-mainnet
     npm run -w contracts verify:base-mainnet
     ```
   - If production promotion is executed outside this repo, record the external deployment record URL and do not substitute an untracked local command.

4. Execute the approved production change.
   - Apply the external deployment/change record or the approved repo deployment command path.
   - Record the start timestamp, operator role, and change reference.

5. Confirm post-cutover runtime identity.
   - Verify the active runtime is `base-mainnet`.
   - Verify the active chain ID is `8453`.
   - Verify the production escrow address matches the reviewed approval record.
   - Verify the active explorer base and USDC address match repo runtime truth.

6. Verify post-cutover service health and evidence paths.
   - Capture service health from the production monitoring system referenced in the change record.
   - Confirm reconciliation and notification evidence generation are active for the production window.
   - Record the first post-cutover evidence links in the change record.

7. Declare the window stabilized.
   - `Engineering Lead`, `Ops Lead`, `Treasury Owner`, and `Incident Commander` all confirm no stop condition is present.
   - Record the stabilization timestamp.

## Rollback triggers

Rollback is mandatory if any of the following occurs during the launch window:

- production deployment/change execution deviates from the approved approval packet
- wrong chain, wrong escrow address, or wrong runtime is detected
- provider posture collapses and fallback is not healthy
- signer custody or execution path violates the approved model
- critical reconciliation drift appears and cannot be classified safely
- emergency containment is requested by the `Incident Commander`

## Rollback steps

Execute these steps in order unless the `Incident Commander` invokes immediate containment first.

1. Declare incident control.
   - Run the process in `docs/incidents/first-15-minutes-checklist.md`.
   - Record the incident start timestamp and owner roles.

2. Halt additional production promotion activity.
   - Stop the active change record or external deployment rollout.
   - Freeze further runtime mutations until containment is understood.

3. Apply the approved rollback entry from the same change-control surface used for cutover.
   - Revert to the last known-good Base-era production deployment and configuration bundle.
   - Do not reactivate retired runtime paths as a rollback shortcut.

4. Verify containment state.
   - Follow `docs/runbooks/emergency-disable-unpause.md` if settlement correctness is uncertain.
   - Confirm unsafe automation is paused or disabled.

5. Revalidate runtime identity and evidence posture.
   - Verify runtime identity, chain ID, and escrow address after rollback.
   - Capture updated service health, provider posture, and reconciliation evidence.

6. Decide stabilization or extended incident handling.
   - If the system is stable, record the rollback completion timestamp.
   - If not stable, continue under incident management and do not resume launch activity.

## Containment posture when rollback is partial or blocked

If rollback cannot complete cleanly:

- `Incident Commander` owns the active incident
- `Ops Lead` owns runtime containment
- `Treasury Owner` owns settlement freeze and audit posture
- `Engineering Lead` owns remediation change review

Containment rules:

- prefer disable/pause controls over improvised runtime edits
- preserve audit evidence for all launch and rollback actions
- do not restore retired operational flows

## Communications path

For every cutover, rollback, or containment event record:

- window ID
- change record URL
- incident record URL when applicable
- current operator role holders
- next update timestamp

The `Incident Commander` owns stakeholder updates and escalation timing.

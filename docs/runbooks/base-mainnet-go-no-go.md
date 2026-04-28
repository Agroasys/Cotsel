# Base Mainnet Go/No-Go

## Purpose and scope

Define the authoritative production approval record for Base mainnet launch.

This runbook exists to answer one question clearly:

- can Cotsel promote Base from production target-state to active production settlement truth for v1?

This runbook covers:

- required evidence for production approval
- required role-based signoff
- explicit no-go conditions
- the approval record that must exist before any production cutover begins

This runbook does not cover:

- protocol feature changes
- ad hoc launch commands outside approved repo/runtime surfaces
- product marketing or external launch communications

Hard prerequisite:

- M4 must already be complete in GitHub state:
  - PR `#400` merged
  - issues `#392`, `#393`, `#394`, and `#344` closed

Control-surface note:

- This file is the authoritative approval template and review checklist for Base mainnet launch readiness.
- It is not, by itself, proof that a Base mainnet launch has already occurred.
- A real launch window must attach a filled approval record, the deployment/change record used for promotion, and any mainnet deployment evidence that exists for that window.

## Authoritative references

- Production baseline readiness: `docs/runbooks/production-readiness-checklist.md`
- Staging release gate: `docs/runbooks/staging-e2e-release-gate.md`
- Staging real release gate: `docs/runbooks/staging-e2e-real-release-gate.md`
- Mainnet cutover and rollback: `docs/runbooks/base-mainnet-cutover-and-rollback.md`
- Incident containment baseline: `docs/incidents/first-15-minutes-checklist.md`
- Signer custody baseline: `docs/runbooks/gateway-governance-signer-custody.md`
- Gateway operational boundary: `docs/runbooks/dashboard-gateway-operations.md`
- Reconciliation evidence generation: `docs/runbooks/reconciliation.md`
- Emergency containment path: `docs/runbooks/emergency-disable-unpause.md`
- Production-sensitive action evidence index: `docs/runbooks/production-sensitive-action-evidence.md`

Base network references:

- Base network/runtime truth in repo: `sdk/src/runtime.ts`
- Base deployment/runtime truth in repo: `contracts/scripts/lib/baseDeploymentConfig.ts`
- Official Base docs: `https://docs.base.org/base-chain/quickstart/connecting-to-base`
- Official Base finality docs: `https://docs.base.org/base-chain/network-information/transaction-finality`
- Official Base explorer docs: `https://docs.base.org/get-started/block-explorers`
- Official Circle USDC addresses: `https://developers.circle.com/stablecoins/usdc-contract-addresses`

## Required approval roles

All four roles must be explicitly recorded in the approval record:

- `Engineering Lead`
- `Ops Lead`
- `Treasury Owner`
- `Incident Commander`

Role rules:

- Use operational roles, not personal names, in the canonical record.
- The launch change record may name the person filling each role for that window.
- If any role is unassigned, the result is automatically `NO-GO`.

## Required evidence before approval

The approval record must link all of the following:

1. M4 proof

- final Base Sepolia evidence packet path or PR reference
- blocker register result
- explicit statement that M4 closure artifacts were reviewed

2. Current staging runtime health

- `scripts/validate-env.sh staging-e2e-real`
- `scripts/docker-services.sh health staging-e2e-real`
- `scripts/staging-e2e-real-gate.sh`
- `scripts/notifications-gate.sh staging-e2e-real`
- latest reconciliation report generated via:
  - `npm run -w reconciliation reconcile:report -- --run-key=<runKey> --out reports/reconciliation/<file>.json`

3. Mainnet runtime truth

- `base-mainnet` runtime selection and chain ID `8453`
- official Base mainnet explorer base
- official Base mainnet USDC address
- current escrow contract address and deployment evidence

4. Provider posture

- named primary RPC provider
- named fallback RPC provider
- confirmation that public Base RPC is not the steady-state production provider
- provider outage escalation owner

5. Signer custody and execution readiness

- signer custody review completed against `docs/runbooks/gateway-governance-signer-custody.md`
- production signer model recorded
- no production plan relies on long-lived raw private-key env injection
- governance execution path and containment path verified

6. Treasury readiness

- treasury operator review completed
- reconciliation evidence reviewed for treasury-linked flows
- payout, freeze, and audit expectations confirmed for launch scope

7. Incident readiness

- incident commander assigned
- containment path reviewed against `docs/incidents/first-15-minutes-checklist.md`
- rollback owner and communications owner assigned

8. Deployment/change control reference

- link to the production deployment system, pipeline, or change record that will perform runtime promotion
- if the production deployment system is external to this repo, its authoritative runbook or change record URL must be attached
- if this reference is missing, the result is automatically `NO-GO`

## Repo-grounded validation commands

These are the required in-repo validation surfaces for launch approval:

```bash
scripts/validate-env.sh staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
scripts/notifications-gate.sh staging-e2e-real
npm run -w reconciliation reconcile:report -- --run-key=<runKey> --out reports/reconciliation/<file>.json
```

Use these contract deployment commands only when mainnet contract deployment is part of the approved launch window:

```bash
npm run -w contracts deploy:base-mainnet
npm run -w contracts verify:base-mainnet
```

Operator rule:

- Do not invent a mainnet docker profile or local-only promotion command.
- Production application deployment and secret rollout are not defined as a repo-local docker profile.
- Launch approval must reference the actual external deployment system when promotion is not executed directly from this repo.

## No-go conditions

The approval outcome is `NO-GO` if any of the following are true:

- M4 is not fully merged and closed remotely
- any required approval role is unassigned
- staging-e2e-real validation is red or unresolved
- reconciliation report includes unresolved critical drift
- notifications gate is red
- signer custody model is incomplete or relies on an unapproved production secret posture
- deployment/change-control record is missing
- rollback ownership is not explicit
- the active repo still presents a retired settlement runtime as live v1 truth

## Stop conditions after review starts

Stop the launch approval immediately and move to incident/change review if:

- new critical security findings appear
- provider posture changes materially during review
- production deployment inputs differ from the reviewed approval packet
- an emergency signer exception is requested without written approval
- legacy runtime retirement work is still incomplete for active CI or API surfaces

## Approval record

Populate this record in the launch ticket, change record, or operator evidence packet.

| Field                          | Value                  |
| ------------------------------ | ---------------------- |
| Launch decision window         | `<window-id>`          |
| Base runtime                   | `base-mainnet`         |
| Chain ID                       | `8453`                 |
| Escrow contract address        | `<address>`            |
| Mainnet deploy/verify evidence | `<path or URL>`        |
| M4 evidence packet             | `<path or URL>`        |
| Staging gate evidence          | `<path or URL>`        |
| Notifications gate evidence    | `<path or URL>`        |
| Reconciliation report          | `<path or URL>`        |
| Primary RPC provider           | `<provider>`           |
| Fallback RPC provider          | `<provider>`           |
| Signer custody reference       | `<path or URL>`        |
| Deployment/change record       | `<path or URL>`        |
| Engineering Lead               | `<role holder>`        |
| Ops Lead                       | `<role holder>`        |
| Treasury Owner                 | `<role holder>`        |
| Incident Commander             | `<role holder>`        |
| Decision                       | `<GO / NO-GO>`         |
| Decision timestamp (UTC)       | `<timestamp>`          |
| Blocking issues                | `<none or issue list>` |

## Approval rule

Launch may proceed only when:

- all required evidence is linked
- all four approval roles are recorded
- decision is explicitly `GO`
- no blocking issue remains unresolved

If any of those are false, launch must not proceed.

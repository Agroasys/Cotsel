# Non-Custodial Pilot User Guide

## Purpose
Help buyer and cooperative participants complete pilot settlement steps safely, without handing custody of signing keys to Agroasys operators.

## Who This Guide Is For
- Buyer participants
- Cooperative/supplier participants
- Pilot support staff assisting non-technical users

## What "Non-Custodial" Means Here
- You control signing approval for your transaction flow.
- Agroasys operators can support the process, but they do not take custody of your private key.
- Every key settlement step is traceable by on-chain and indexed records.

## Before You Start
- You received your pilot environment URL and participant account access.
- Your pilot trade details are confirmed with your coordinator:
  - `tradeId`
  - expected amount and currency
  - counterparties (buyer/supplier)
- Support contact details are available (see Assistance section below).

## Participant Flow

### Step 1: Login and Session Setup
1. Open the pilot application URL shared by your coordinator.
2. Sign in with your assigned pilot identity method.
3. Confirm your account/session is active before proceeding to trade actions.

Expected result:
- You can view your participant dashboard and assigned trade(s).

### Step 2: Review Trade Details Before Signing
Before you approve any lock/sign action, confirm:
- `tradeId` matches your pilot instruction sheet.
- Buyer and supplier/cooperative identities are correct.
- Total amount and split amounts match expected agreement.
- Ricardian/legal agreement reference is present for the trade.
- Status is in a pre-lock state (not already finalized).

If any check fails, stop and escalate before signing.

### Step 3: Sign the Lock/Approval Action
1. Open the target trade.
2. Use the wallet/sign prompt to approve the lock or required participant action.
3. Wait for confirmation response in the UI.

Expected result:
- A transaction reference (`txHash` / `extrinsicHash`) is shown or logged.
- Trade status moves forward (for example, to locked/in-progress).

### Step 4: Track Settlement Status
Use the status tracker to monitor progression:

| Status | Meaning | Participant Action |
|---|---|---|
| `LOCKED` | Buyer funds locked in escrow | Wait for oracle progression |
| `IN_TRANSIT` | Stage-1 release processed; shipment in progress | Monitor arrival/dispute window |
| `ARRIVED` | Arrival confirmed; dispute window active | Raise dispute only if required |
| `COMPLETED` | Final tranche released; settlement complete | Archive evidence and confirmation |
| `FROZEN` / dispute state | Trade is under dispute governance | Follow support/on-call guidance |

If your dashboard shows equivalent wording, map it to these lifecycle meanings.

## Pilot Environment Validation (Operator-Assisted)
This guide is validated against the `staging-e2e-real` pilot profile.
Operators should confirm environment readiness before participant sessions using:

```bash
scripts/validate-env.sh staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
```

Reference runbook:
- `docs/runbooks/staging-e2e-real-release-gate.md`

## Common Issues and What To Do

### Login/session problems
- Symptom: you cannot enter dashboard or session expires quickly.
- Action: retry once, then contact Support with timestamp and user ID.

### Signature prompt fails or does not appear
- Symptom: action stays pending with no wallet/sign dialog.
- Action: refresh once, re-open trade, retry action once, then contact On-call.

### Status not updating after signing
- Symptom: trade remains unchanged for longer than expected.
- Action: capture trade ID + timestamp + screenshot and contact On-call.

### You suspect incorrect trade details
- Symptom: amount/party/reference mismatch.
- Action: do not sign; contact Support immediately and request Ops verification.

## Assistance Paths

| Role | Use For | First Response Target |
|---|---|---|
| Support | Login/session/access issues, participant guidance | `<15 min` |
| On-call Engineer | Signing/status/transaction anomalies | `<15 min` |
| Ops Lead | Environment/configuration validation and escalation decisions | `<30 min` |

When requesting help, always include:
- `tradeId`
- participant role (buyer/cooperative)
- local timestamp (UTC preferred)
- observed status
- tx hash/extrinsic hash (if available)
- screenshot or exact error text

## Safety Rules
- Do not share seed phrases, private keys, or raw auth secrets.
- Do not sign if trade identity/amount/reference checks fail.
- Use only approved pilot environment URLs.
- Escalate early if settlement status appears inconsistent.

## Related Runbooks
- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/demo/community-demo-checklist.md`
- `docs/runbooks/demo/community-demo-script.md`
- `docs/runbooks/oracle-redrive.md`

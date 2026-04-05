# Gateway Governance Signer Custody

> **Architecture decision notice — 2026-04-05**
>
> [ADR-0411](../adr/adr-0411-human-governance-direct-wallet-signing.md) supersedes the queued executor as the long-term target for **human privileged governance**. That ADR is the authoritative decision record for the governance signing model.
>
> This runbook remains the operational procedure for the **executor signer** during the migration period and for **delegated/service roles** that will remain executor-backed permanently. Procedures in this runbook that describe executor-signed human governance actions are **transitional** and will be replaced when Phase 1 (gateway prepare endpoints) and Phase 4 (runbook update) of ADR-0411 are complete.
>
> For the target human governance signing model, see:
> - [ADR-0411](../adr/adr-0411-human-governance-direct-wallet-signing.md)

## Purpose and scope
Define the approved signer-custody boundary for gateway-governed protocol actions and the operator procedures required before any governance executor action is run.

This runbook applies to:
- `gateway/src/executor/adminSdkGovernanceChainExecutor.ts`
- `npm run -w gateway execute:governance-action -- <actionId>`
- emergency disable and controlled unpause actions (transitional — human governance target is direct wallet signing per ADR-0411)
- treasury payout receiver governance changes (transitional — target is direct wallet signing per ADR-0411)
- oracle governance changes (transitional — target is direct wallet signing per ADR-0411)
- delegated/service execution (oracle attestation, automated maintenance) — remains executor-backed permanently

This runbook does not change protocol quorum rules. It defines how the executor signer is sourced, approved, rotated, and used safely.

No-AA boundary for privileged paths:
- governance executor actions, treasury sweeps, payout-receiver changes, compliance overrides, and operator-admin sessions use direct wallet or managed-signer execution only
- buyer-facing account abstraction, paymaster support, or sponsored-gas experiments must not be reused for privileged actions
- privileged flows require explicit signer identity, approval evidence, and audit records for every execution step

Automation-governance source of truth:
- `docs/runbooks/programmability-governance.md`

## Current code boundary
Current executor code loads a raw `GATEWAY_EXECUTOR_PRIVATE_KEY` and instantiates an `ethers.Wallet` directly inside `adminSdkGovernanceChainExecutor.ts`.

**Transitional status:** This boundary is the operative model during migration. Per ADR-0411, human privileged governance actions (pause, unpause, approval methods, treasury operations, oracle updates) are migrating to direct admin wallet signing. The executor path for those actions is transitional and will be retired once Phase 1 and Phase 2 of ADR-0411 are complete.

**Permanent scope:** Delegated/service operations (oracle attestation service, automated maintenance runners) remain executor-backed and are not affected by this transition.

Interpretation for the executor boundary during migration:
- local development and deterministic staging validation may use `GATEWAY_EXECUTOR_PRIVATE_KEY`
- production readiness must not rely on a long-lived raw environment private key managed like a convenience secret
- the gateway API process must never hold the signer key; only the isolated executor invocation may access signer material
- no smart-wallet or paymaster shortcut is an approved replacement for this signer boundary

Until a managed signer adapter exists in code, production approval is limited to environments where the raw private key is injected from a managed custody system for a bounded execution window and never persisted in source control, images, CI logs, or long-lived shell history.

## Approved custody models
### Local and CI validation
- Ephemeral test key allowed.
- Key scope is non-production only.
- Key may be environment injected for the duration of the test run.

### Staging and pilot validation
- `GATEWAY_EXECUTOR_PRIVATE_KEY` is allowed only for isolated staging or pilot environments with named operator ownership.
- Key must be distinct from local/dev keys and rotated on any operator change or suspected exposure.
- Access must be limited to the executor host/session used for the approved validation window.

### Production
- Approved custody boundary is managed signing only: HSM, KMS-backed signing, or an equivalent delegated signer service with auditable request history.
- The executor host may trigger a signing request, but production operators must not manually copy or reuse a raw private key across sessions.
- Raw key export is not an approved steady-state production model.
- Any temporary exception requires written approval from the Incident Commander plus Security/Platform owner, a start and end time, and same-day rotation after use.

## Approval and execution procedure
Before running `execute:governance-action`, operators must record:
- `actionId`
- `intentKey`
- expected contract method
- target admin signer address
- linked incident/change record
- approver identities and time of approval

Required approvals:
- normal governance execution: Service Owner plus one peer reviewer
- emergency disable path: Incident Commander plus Service Owner
- recovery or unpause path: protocol quorum evidence plus Incident Commander approval to resume

Execution steps:
1. Verify the queued action details from the gateway API and confirm the signer address expected by the queued action.
2. Verify the signer source matches the approved custody model for the environment and is not a buyer-facing AA/sponsorship path.
3. Start a bounded executor session with only the env vars required for that action.
4. Run `npm run -w gateway execute:governance-action -- <actionId>`.
5. Capture resulting `txHash`, `blockNumber`, `requestId`, and audit log row.
6. End the session and remove any temporary secret material from the shell/session context.

## Rotation and revocation
Rotate the signer immediately when any of the following occurs:
- operator change or offboarding
- suspected secret exposure
- emergency exception used a raw exported key
- signer address no longer matches the approved admin/quorum mapping

Rotation minimums:
1. Provision the new signer in the managed custody system.
2. Record the new signer address and approval record.
3. Validate the signer in non-production first.
4. Update environment injection on the executor host only.
5. Revoke the previous signer and archive the rotation evidence.

Required evidence:
- old signer address
- new signer address
- approving operators
- validation timestamp
- rollback plan if the new signer fails

## Break-glass and emergency disable
Break-glass use is limited to containment actions such as `pause`, `pauseClaims`, or `disableOracleEmergency`.

Rules:
- use the narrowest action that safely contains the incident
- record the incident URL before execution if at all possible
- do not use a break-glass signer session to perform recovery or unpause actions
- do not route break-glass or treasury execution through buyer wallet bootstrap, sponsorship, or paymaster helpers
- after break-glass use, rotate the signer or revoke the exception before reopening normal execution

For emergency actions, also follow:
- `docs/runbooks/emergency-disable-unpause.md`
- `docs/incidents/first-15-minutes-checklist.md`

## Evidence and audit minimums
Every signer-backed governance execution must leave:
- gateway `actionId`
- `requestId` and `correlationId`
- signer address used
- operator identity
- approval record or incident record
- `txHash` and `blockNumber`
- post-execution verification note

Store the operator packet in:
- `docs/runbooks/operator-audit-evidence-template.md`
- `docs/incidents/incident-evidence-template.md` when incident-driven

## References
- `docs/runbooks/dashboard-gateway-operations.md`
- `docs/runbooks/emergency-disable-unpause.md`
- `docs/runbooks/production-readiness-checklist.md`

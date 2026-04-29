# Operator Signer Authority Program

## Purpose

Lock the implementation target for operator signer authority across `Cotsel` and `Cotsel-Dash`.

This note is not a replacement for:

- [`docs/adr/adr-0411-human-governance-direct-wallet-signing.md`](../adr/adr-0411-human-governance-direct-wallet-signing.md)
- [`docs/adr/adr-0412-treasury-revenue-controls-boundary.md`](../adr/adr-0412-treasury-revenue-controls-boundary.md)

It exists to freeze the historical baseline, the implemented Batch 1-5 runtime truth in `Cotsel`, and the remaining end-state for the operator signer hardening program.

## Current Runtime State After Batch 1-5

### 1. Session access remains the operator identity boundary

- `auth` is still the authoritative session service.
- Production intent remains trusted upstream session exchange, not wallet-first operator login.
- `gateway` still resolves bearer sessions from `auth` and maps auth role `admin` into gateway operator roles.
- Trusted admin session exchange does not by itself manufacture signer authority. Session access and signer authority are distinct backend decisions.

Relevant runtime surfaces:

- `auth/src/api/sessionController.ts`
- `auth/src/core/sessionService.ts`
- `auth/src/database/queries.ts`
- `gateway/src/core/authSessionClient.ts`
- `gateway/src/middleware/auth.ts`

### 2. Operator capabilities and signer bindings are backend-managed session truth

- `auth/session` now emits both operator capabilities and approved signer bindings.
- `gateway` does not broaden missing capability data into full operator power.
- Durable admin profile provisioning does not silently grant every operator capability. Operator capabilities must be explicitly provisioned through admin-control.
- Signer authority is explicitly resolved from backend-managed signer bindings by:
  - operator account
  - wallet address
  - action class
  - environment

Relevant runtime surfaces:

- `auth/src/api/sessionController.ts`
- `auth/src/database/queries.ts`
- `auth/src/core/operatorAuthorityStore.ts`
- `gateway/src/core/authSessionClient.ts`
- `gateway/src/middleware/auth.ts`

### 2.1 Cotsel#489 staging provisioning flow

Use admin-control routes for staging rehearsal provisioning. Manual SQL was used once to unblock the first staging diagnosis, but it is not the production process and must not be repeated as the normal path.

Required admin-control calls:

1. `POST /admin/profiles/provision`
   - `accountId`: rehearsal operator account, for example `demo-admin-001`
   - `role`: `admin`
   - `walletAddress`: `0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a`
   - `capabilities`: include only the explicit capabilities needed, for #489 at least `governance:write` and `compliance:write`
   - `capabilityTicketRef`: `COTSEL-489`
2. `POST /admin/signers/provision`
   - `accountId`: same rehearsal operator account
   - `walletAddress`: `0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a`
   - `actionClass`: `governance`
   - `environment`: `production` for the current staging gateway signer policy
   - `ticketRef`: `COTSEL-489`

The signer binding table columns used by the current schema are `account_id`, `wallet_address`, `action_class`, `environment`, `active`, `provisioned_by`, `provision_reason`, `provision_ticket_ref`, `notes`, `metadata`, `created_at`, `updated_at`, `revoked_at`, `revoked_by`, and `revoked_reason`. Code and tests must align to those names; do not guess alternate names such as `signer_wallet`, `signer_address`, `granted_by`, `reason`, or `is_active`.

### 2.2 Dashboard operator session script base URL

For legacy wallet-login smoke checks only, `scripts/dashboard-operator-session.mjs` now supports both auth base styles:

- direct auth container base: `DASHBOARD_SMOKE_AUTH_BASE_URL=http://127.0.0.1:3005`
- routed public auth base: `DASHBOARD_SMOKE_AUTH_BASE_URL=https://cotsel.sys.agroasys.com/api/auth/v1`

If `/challenge` returns `404`, the script tries the alternate direct/routed path and reports every attempted challenge URL with status and a safe response-body preview. It writes the session artifact only after challenge, login, and `/session` validation succeed, so a failed login does not overwrite a previously valid `COTSEL_SESSION_ID` artifact with empty output.

### 2.4 Failure meanings

- `FORBIDDEN Operator capability 'governance:write' is required`: the session may be admin, but backend capability truth does not grant governance write authority.
- `SIGNER_NOT_AUTHORIZED`: the session has the governance capability, but the requested signer wallet is not actively approved for action class `governance` in the gateway signer environment.
- `disabled_or_not_allowlisted`: the session has capability truth, but gateway mutation enablement or write allowlist posture blocks writes before action-specific signer policy.

### 3. Governance direct-sign requires an approved governance signer wallet

- Human governance uses `prepare -> wallet sign/broadcast -> confirm -> verify/monitor`.
- Governance prepare and confirm both require an approved signer binding for action class `governance`.
- Human queue-style governance POST routes are retired and fail closed.
- Prepared governance payloads are bound to the expected signer wallet, and confirm verifies the same signer wallet against the observed chain transaction.
- A successful prepare-only staging response has this proof shape:
  - `success: true`
  - `data.status: prepared`
  - `data.category: pause`
  - `data.signing.chainId: 84532`
  - `data.signing.contractAddress: 0x37F5d97fd9D227dd39391ACfC3C77FDF7c7F742A`
  - `data.signing.contractMethod: pause`
  - `data.signing.txRequest.data: 0x8456cb59`
  - `data.signing.signerWallet: 0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a`
  - `data.signing.preparedPayloadHash`: non-empty hash
  - no broadcast or execution step

Relevant runtime surfaces:

- `gateway/src/routes/governanceMutations.ts`
- `gateway/src/core/governanceMutationService.ts`
- `gateway/src/core/governanceStore.ts`

### 4. Treasury has an explicit session-only vs signer-required policy

- Treasury preparatory actions remain session/capability/write-posture controlled.
- Treasury close-, approval-, and execution-sensitive actions require explicit signer bindings.
- Treasury signer policy is carried into downstream metadata and gateway audit records.

Relevant runtime surfaces:

- `gateway/src/routes/treasury.ts`
- `gateway/src/core/treasuryWorkflowService.ts`
- `docs/adr/adr-0412-treasury-revenue-controls-boundary.md`

## Historical Baseline Before Batch 1-5

### 1. Historical authoritative session model

- Session auth is the authoritative operator identity/access boundary.
- `auth` remains the Cotsel session service.
- Production intent is trusted upstream session exchange, not wallet-first login.
- `gateway` resolves bearer sessions from `auth` and maps auth role `admin` to gateway operator roles.
- Wallet connection alone does not create operator authority.

Relevant runtime surfaces:

- `auth/src/api/sessionController.ts`
- `auth/src/core/sessionService.ts`
- `gateway/src/core/authSessionClient.ts`
- `gateway/src/middleware/auth.ts`

### 2. Historical signer model

- Governance already has a real `prepare -> wallet sign/broadcast -> confirm -> verify/monitor` backend path.
- Governance signer verification is currently anchored to the wallet bound to the authenticated admin session.
- There is no explicit backend-managed operator signer authorization model that answers:
  - which wallet is approved
  - for which action class
  - in which environment
- Treasury signer posture is inconsistent. Some sensitive actions require a wallet-bound session; others do not.
- `Cotsel-Dash` already distinguishes session access from signing readiness in UI/state, but that is not the same as backend-enforced signer authority.

Relevant runtime surfaces:

- `gateway/src/core/governanceMutationService.ts`
- `gateway/src/routes/governanceMutations.ts`
- `gateway/src/routes/treasury.ts`
- `Cotsel-Dash/src/lib/api/auth-session.ts`
- `Cotsel-Dash/src/pages/Governance.tsx`

### 3. Privileged actions that already required wallet-bound behavior

Current backend wallet-bound enforcement exists for:

- governance direct-sign preparation
- governance direct-sign confirmation
- queued governance approval/cancel preflight checks that inspect approver wallet identity
- treasury sweep-batch approval
- treasury execution match
- treasury sweep-batch close

Relevant runtime surfaces:

- `gateway/src/routes/governanceMutations.ts`
- `gateway/src/routes/treasury.ts`

### 4. Privileged actions that did not require wallet-bound behavior and needed explicit policy review

Current backend session/capability/write-allowlist gating exists without signer enforcement for:

- treasury accounting-period close request
- treasury accounting-period close
- treasury sweep-batch approval request
- treasury external handoff recording
- treasury realization creation
- compliance mutation/control actions

These are not automatically all signer-required, but they must be deliberately classified and can no longer remain in an accidental mixed state.

Relevant runtime surfaces:

- `gateway/src/routes/treasury.ts`
- `gateway/src/routes/compliance.ts`
- `gateway/src/core/treasuryWorkflowService.ts`

### 5. Historical operator wallet path in Dash

- Connected-mode wallet usage currently flows through `src/lib/integrations/web3layer-sdk.ts`.
- That adapter dynamically imports `@agroasys/sdk` and expects `BuyerSDK` plus `web3Wallet`.
- The repo-local SDK exports `web3Wallet` only from the legacy entrypoint and backs it with a deprecated `Web3Auth` wrapper.
- Session bootstrap prefers platform session exchange when configured, but falls back to a legacy wallet-signed admin bootstrap path when it is not.

Relevant runtime surfaces:

- `Cotsel-Dash/src/lib/integrations/web3layer-sdk.ts`
- `Cotsel-Dash/src/lib/api/auth-session.ts`
- `sdk/src/legacy.ts`
- `sdk/src/wallet/wallet-provider.ts`

### 6. Suitability of the historical wallet path for the target operator model

The current wallet path is not yet suitable as the final internal-operator signer model.

Reasons:

- it is transitional
- it is legacy-shaped
- it is not a dedicated external operator wallet connector
- it is too close to an embedded-wallet compatibility path
- it does not by itself prove backend signer authorization truth

### 7. Runtime surfaces that already hint at signer truth but do not fully enforce it

- trusted wallet/account linkage in `auth`
- gateway global write allowlist
- treasury capability partitions in `gateway`
- governance prepared signer wallet and post-broadcast verification
- platform signing readiness shape in `Cotsel-Dash`
- UI separation of session access vs signing readiness in `Cotsel-Dash`

These are useful building blocks, but they do not yet form an explicit backend-approved operator signer model.

## Target End-State

The target professional model is:

- session auth remains the identity/access boundary for the dashboard
- backend remains the source of role and signer authorization truth
- session exchange or admin session issuance must not silently expand into full operator capability or signer authority without explicit backend provisioning
- sensitive actions require step-up signing through an approved external wallet
- the approved signer wallet is explicitly bound to an operator identity
- signer authorization is action-class-aware
- signer authorization is environment-scoped
- governance is the first complete reference implementation
- treasury and other sensitive operator actions are classified deliberately as either session-only or signer-required
- `MetaMask` and `Rabby` become the preferred operator signing path
- hardware-wallet-backed operator usage must work naturally through that path
- transitional/legacy operator signing paths must not remain a competing trust model once the hardened path is complete
- audit evidence must show operator identity, signer wallet, policy decision, action class, environment, and execution artifact

## Architecture Correction Check

The implementation must preserve two distinct backend decisions:

1. Session access authority
   `auth` and trusted upstream session exchange decide whether the operator can enter the dashboard and under which internal account/role context.
2. Signer authority
   `auth`-managed capability and signer-binding truth, consumed by `gateway`, decide whether the connected wallet is approved to sign a privileged action class in the current environment.

Implications:

- a connected wallet is a signing instrument, not an identity system
- a trusted admin session must not, by itself, auto-grant signer authority
- governance/treasury/compliance-sensitive routes must check backend signer truth explicitly
- `Cotsel-Dash` operator wallet work must remain downstream of this backend authority model, not define it

## Non-Goals

This program must not:

- replace session auth with wallet auth
- treat wallet connection as role truth
- build a second operator identity system
- redesign buyer or participant wallet flows
- redesign settlement contracts for a dashboard/operator signing problem
- over-harden every treasury click without policy justification
- preserve stale transition paths as if they were production truth

## Implementation Order

The execution order for this program is:

1. freeze baseline and issue structure
2. introduce backend signer authorization truth
3. align capability truth and session payload behavior
4. harden governance against the new signer model
5. classify treasury actions by signer policy
6. enforce treasury signer policy in backend
7. replace the operator wallet connector in `Cotsel-Dash`
8. align governance UX to the hardened model
9. align treasury UX to the hardened model
10. review compliance and other privileged mutation surfaces
11. encode break-glass signer policy
12. harden audit/observability evidence
13. finish cleanup, validation, and PR hygiene

## Treasury Action Policy Matrix

This matrix is the Batch 4 policy decision for the current treasury mutation surface.

### Session-only operator actions

- `POST /treasury/accounting-periods`
  Reason: period creation is preparatory workflow state, not a final approval or execution attestation.
- `POST /treasury/sweep-batches`
  Reason: batch creation is preparatory and does not finalize sensitive treasury state.
- `POST /treasury/sweep-batches/:batchId/entries`
  Reason: entry allocation is an internal preparation step that remains subject to later approval and close controls.

### Signer-required privileged actions

- `POST /treasury/accounting-periods/:periodId/request-close`
  Signer class: `treasury_close`
  Reason: requesting close is a sensitive attestation that the period is ready to enter close control.
- `POST /treasury/accounting-periods/:periodId/close`
  Signer class: `treasury_close`
  Reason: closing a period finalizes sensitive accounting state.
- `POST /treasury/sweep-batches/:batchId/request-approval`
  Signer class: `treasury_approve`
  Reason: moving a batch into approval posture is a privileged approval step, not simple preparation.
- `POST /treasury/sweep-batches/:batchId/approve`
  Signer class: `treasury_approve`
  Reason: approval is a direct privileged control decision.
- `POST /treasury/sweep-batches/:batchId/match-execution`
  Signer class: `treasury_execute`
  Reason: execution matching attests that sensitive on-chain sweep evidence matches treasury state.
- `POST /treasury/sweep-batches/:batchId/external-handoff`
  Signer class: `treasury_execute`
  Reason: partner-handoff recording is an execution-stage attestation with external control significance.
- `POST /treasury/sweep-batches/:batchId/partner-handoff`
  Signer class: `treasury_execute`
  Reason: legacy alias of the same execution-stage handoff mutation.
- `POST /treasury/sweep-batches/:batchId/close`
  Signer class: `treasury_close`
  Reason: closing a batch finalizes a sensitive treasury workflow stage.
- `POST /treasury/entries/:entryId/realizations`
  Signer class: `treasury_close`
  Reason: realization creation finalizes revenue recognition state and must not remain session-only.

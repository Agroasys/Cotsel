# ADR-0411: Supersede Queued Executor as Default for Human Privileged Governance — Adopt Direct Admin Wallet Signing

- Status: Accepted
- Date: 2026-04-05
- Related issue: [#411](https://github.com/Agroasys/Cotsel/issues/411)
- Supersedes: [Decision: Dashboard gateway governance signing model #215](https://github.com/Agroasys/Cotsel/issues/215)

## Custody clarification — 2026-09-11

For the controlled pilot and production, an admin-controlled wallet means a
dedicated hardware-backed wallet assigned to one authorized human custodian.
The three contract administrator keys are generated and held independently,
share no seed or recovery material, and are never created in KMS or exposed to a
backend workload. Wallet software may transport a prepared transaction, but
physical approval occurs on the hardware device. This clarification does not
change the chosen direct-sign architecture; it makes its production custody
boundary explicit.

## Implementation status — 2026-09-12

The repository implements the gateway portion of this decision:

- versioned signer-register and governance-action migrations;
- explicit, active, environment-scoped signer bindings;
- action-specific prepare routes;
- immutable operator intent and canonical unsigned transaction records;
- post-broadcast transaction verification and confirmation monitoring; and
- no governance queue, executor, replay worker, CLI executor, KMS signer, or
  server-held governance key.

This source implementation is not deployment or acceptance evidence. The flow
must remain disabled until the migrations and reviewed release are deployed,
three named hardware-wallet custodians are registered, Cotsel-Dash is verified
against the API contract, and a witnessed two-admin rehearsal passes.

## Context

The queued gateway and executor-signer model was approved under issue #215 as a
pilot design. It would have routed human-initiated privileged actions through a
backend queue and signed them with a key held by a workload.

That design is rejected for human privileged governance because:

1. A machine-held key cannot prove that the named human custodian approved the
   exact on-chain transaction.
2. A shared workload signer would collapse independent administrator custody.
3. A queue or replay worker could sign after the human session and reviewed
   transaction context no longer matched current intent.

## Decision

**Human privileged governance actions use direct hardware-wallet signing.**

The gateway authenticates the operator session, requires the exact active signer
binding, validates pre-flight state, prepares the canonical unsigned
transaction, records audit intent, and independently verifies and monitors the
broadcast transaction. Signing and broadcast originate from the named
hardware-wallet custodian. The gateway never possesses a governance private key.

There is no delegated governance executor. Oracle and gasless-relayer signing
are separate automated service authorities with isolated keys and task roles;
neither may sign or replay a governance action.

## Action Classification

### Governance actions

Every governance action is signed directly by the admin wallet.

| Action                                  | Contract method                                    |
| --------------------------------------- | -------------------------------------------------- |
| Protocol pause                          | `pause`                                            |
| Scoped unpause proposal                 | `proposeUnpause`                                   |
| Unpause approval                        | `approveUnpause`                                   |
| Unpause proposal cancel                 | `cancelUnpauseProposal`                            |
| Claims pause                            | `pauseClaims`                                      |
| Claims unpause                          | `unpauseClaims`                                    |
| Treasury sweep                          | `claimTreasury`                                    |
| Treasury payout receiver proposal       | `proposeTreasuryPayoutAddressUpdate`               |
| Treasury payout receiver approval       | `approveTreasuryPayoutAddressUpdate`               |
| Treasury payout receiver execute        | `executeTreasuryPayoutAddressUpdate`               |
| Treasury payout receiver cancel expired | `cancelExpiredTreasuryPayoutAddressUpdateProposal` |
| Oracle disable emergency                | `disableOracleEmergency`                           |
| Oracle update proposal                  | `proposeOracleUpdate`                              |
| Oracle update approval                  | `approveOracleUpdate`                              |
| Oracle update execute                   | `executeOracleUpdate`                              |
| Oracle update cancel expired            | `cancelExpiredOracleUpdateProposal`                |

Administrator, threshold, and relayer membership changes are not exposed by
the current gateway prepare contract. They remain unsupported direct contract
operations until a separate reviewed API and operating procedure is accepted.

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
   │  ├── Require the exact active signer-register binding
   │  ├── Validate pre-flight state (paused, proposal existence, quorum, timelock)
   │  ├── Build canonical action payload (`chainId`, `contractAddress`, `contractMethod`, `args`, `txRequest`)
   │  └── Record audit intent (session/account identity, expected signer wallet, action category, idempotency key)
   │
   ▼
Gateway response: { actionId, intentKey, signing: { contractMethod, args, txRequest, signerWallet, preparedPayloadHash } }
   ← prepared; not yet signed or broadcast
   │
   ├── Step 3: Admin reviews action details in dashboard (wallet not yet involved)
   │
   ▼
Admin hardware wallet (connected through compatible wallet software)
   │  └── Step 4: Admin signs and broadcasts, wallet appears only at this step
   │
   ▼
Chain (Base / Base Sepolia)
   │
   ▼
Gateway (monitor phase)
   │  ├── Receive txHash from dashboard post-broadcast
   │  ├── Verify tx against the prepared payload when observable
   │  ├── Record `broadcast_pending_verification` if the tx is not yet observable
   │  ├── Update action record with txHash, final signer wallet, blockNumber, verification state, final status
   │  └── Emit audit evidence (reconciliation, evidence capture)
```

The gateway retains its role as the trusted orchestration backend. It moves from signing agent to payload preparer and post-broadcast monitor. Blockchain details (chain IDs, RPCs, gas, raw tx parameters) are operational internals, they must not dominate the admin UX and should appear only where operationally useful.

## Alternatives Considered

### A) Keep queued executor with enforced signer match (rejected)

- Pros: simpler dashboard integration; no frontend wallet-sign flow required.
- Cons: backend process holds admin key material; human approval identity is mediated by a machine key rather than the approving wallet signing directly; does not meet audit requirements for multi-admin governance.

### B) Direct hardware-wallet signing for human governance (chosen)

- Pros: aligns the named approving custodian with the on-chain signer and keeps
  all administrator keys outside workloads.
- Cons: requires phased migration across gateway, dashboard, auth/step-up, and runbooks.

## Risk Analysis

### Transition period

The repository contains no governance executor fallback. During rollout,
governance mutations stay disabled until the direct-sign release and migrations
are deployed and rehearsed. Operators must not use an old checkout, raw contract
call, KMS key, or database write as a substitute.

### Wallet availability

Direct wallet signing requires the operator wallet to be available and connected at execution time. Hardware wallet must be confirmed before any emergency governance action.

Mitigation:

- Emergency runbooks must be updated to include wallet availability as a pre-execution check.
- The signer register and write allowlist must be rechecked before preparation.

### Dashboard signing integration

The dashboard must implement wallet-connect governance signing. The presence of
dashboard signing code is not sufficient by itself: the gateway preparation,
intent recording and post-broadcast verification phases must also be live for
the target flow to be complete.

Mitigation:

- Gateway prepare and confirm endpoints must be tested independently and then
  in an end-to-end browser flow with the dashboard.

### Superseded decision

- [Decision: Dashboard gateway governance signing model #215](https://github.com/Agroasys/Cotsel/issues/215)

### Implemented repository surfaces

- `auth/src/database/schema/002_operator_signer_register.sql` — explicit signer authority
- `gateway/src/routes/governance*PrepareRoutes.ts` — prepare endpoints
- `gateway/src/routes/governanceDirectSignMutations.ts` — confirmation endpoint
- `gateway/src/core/governanceMutationService.ts` — canonical payload and verification boundary
- `gateway/src/core/governanceDirectSignMonitor.ts` — confirmation and finality monitoring
- `docs/runbooks/gateway-governance-signer-custody.md` — custody and operator procedure
- `docs/api/cotsel-dashboard-gateway.openapi.yml` — direct-sign prepare + confirm contract aligned with implementation
- `docs/runbooks/architecture-coverage-matrix.md` — row added for this decision

### Related decisions and issues

- [#215](https://github.com/Agroasys/Cotsel/issues/215) — superseded by this ADR (anchored; no longer treated as forward direction)
- [#412](https://github.com/Agroasys/Cotsel/issues/412) — Phase 1 gateway implementation (prepare + confirm endpoints)
- [Cotsel-Dash #137](https://github.com/Agroasys/Cotsel-Dash/issues/137) — Phase 2 dashboard governance signing migration
- [Cotsel-Dash #139](https://github.com/Agroasys/Cotsel-Dash/issues/139) — Phase 2 dashboard governance signing migration
- [#123](https://github.com/Agroasys/Cotsel/issues/123) — API gateway runtime orchestration (related)

## Rollback

Rollback disables gateway mutations and rolls back the application release; it
does not restore a queue, executor, raw key, or manual contract-call path. A
change to the custody decision requires a new superseding ADR, updated threat
and recovery analysis, independent review, and renewed acceptance.

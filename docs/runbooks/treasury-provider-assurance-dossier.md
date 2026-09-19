# Treasury External-Provider Assurance Dossier

The record COMP-06 requires for every external payout provider treasury relies
on, and the explicit statement of what remains unresolved.

- **Owner:** Treasury and Finance owners, with Compliance and Legal
- **Traceability:** WP-4, control COMP-06 ([Agroasys/Cotsel#656](https://github.com/Agroasys/Cotsel/issues/656))
- **Primary gate:** E-3 (data integrity)
- **External dependency:** **Yes — unresolved.** See [Status](#status).

## Status

**This dossier is a template with no approved instance.**

COMP-06 requires provider due diligence, executed service terms, data-processing
obligations and named escalation ownership. Those are decisions of Legal,
Compliance and Finance — not engineering artifacts — and they cannot be produced
from inside this repository. They are recorded here as an unresolved external
dependency, which is what the work package requires of a dependency nobody has
closed: it stays explicit and is not replaced by Cotsel-local evidence.

The engineering half of COMP-06 **is** delivered, and is listed under
[What Cotsel already enforces](#what-cotsel-already-enforces). A reviewer should
read the two sections together: the controls below are real and testable, and
they are not a substitute for the approvals above them.

## What Cotsel already enforces

These are in the codebase today and have tests. They satisfy the technical
requirements COMP-06 names — authenticated requests and callbacks, authoritative
state mapping, and fail-closed outage handling.

| COMP-06 requirement                       | Where it lives                                                                     | Evidence                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Callback authentication                   | `auth/providerCallback.ts`, `core/providerCallbackAuth.ts`                         | `providerCallbackAuth.test.ts`, `providerCallbackRoutes.test.ts`      |
| Replay and skew rejection                 | Nonce store + `TREASURY_PROVIDER_CALLBACK_MAX_SKEW_SECONDS`                        | `replayProtection.test.ts`                                            |
| Authoritative provider-state mapping      | `core/providerHandoffAuthority.ts`                                                 | [handoff authority runbook](./treasury-provider-handoff-authority.md) |
| Fail-closed on unmapped states            | `resolveProviderHandoffAuthority` refuses; DB pins the vocabulary                  | `providerHandoffAuthority.postgres.test.ts`                           |
| Conflicting-evidence containment          | Freeze + append-only conflict record                                               | `providerHandoffAuthority.postgres.test.ts`                           |
| Completion requires provider evidence     | `assertCompletionEvidence`                                                         | `providerHandoffAuthority.test.ts`                                    |
| Production refuses unverifiable callbacks | `loadConfig` rejects `TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED=false` in production | `config.nonceStore.test.ts`                                           |

Operational procedure for the one integrated provider is in
[Bridge treasury handoff operations](./bridge-treasury-handoff-operations.md).

## What each provider dossier must record

One instance of this section per provider, approved before that provider carries
value in a pilot or on mainnet.

### 1. Provider identity and due diligence

- Legal entity, jurisdiction, and regulatory permissions relied upon.
- Due-diligence review: who performed it, on what date, with what outcome.
- Financial-crime and sanctions posture, and how it is re-reviewed.
- Re-review cadence and the trigger that forces an early one.

### 2. Service terms

- Executed contract reference, effective date, and termination terms.
- Service levels relied upon operationally, and what happens when they are missed.
- Liability and loss allocation for a failed, duplicated or misdirected payout.
- Notice obligations for incidents and for material change to the provider's own service.

### 3. Data-processing obligations

- Personal data transferred, lawful basis, and transfer mechanism.
- Data-processing agreement reference and sub-processor list.
- Retention and deletion obligations, and how Cotsel evidences compliance.
- What Cotsel must **not** send, stated positively so it can be tested.

### 4. Authentication and callback security

- Credential type, rotation cadence, and custody for both directions.
- Callback signing scheme, the exact signed payload, and the skew window.
- Replay defence and the idempotency key the provider guarantees.
- Allowed source ranges or mutual TLS, where the provider offers them.

### 5. Authoritative state mapping

**Every** state the provider can emit, mapped to one of Cotsel's four
authorities. The mapping in `core/providerHandoffAuthority.ts` is the
implementation; this table is the approval of it.

| Provider state                 | Cotsel authority                                                | Approved by | Date |
| ------------------------------ | --------------------------------------------------------------- | ----------- | ---- |
| _(one row per provider state)_ | `NOT_HANDED_OFF` / `IN_FLIGHT` / `COMPLETE` / `TERMINAL_FAILED` |             |      |

A state the provider can emit and this table does not name is a gap, not a
default. Cotsel refuses an unmapped state at the route and in the database, so
the failure mode of an incomplete table is a refusal, not a false completion —
but it is still an incomplete table.

### 6. Outage and escalation

- What Cotsel does when the provider is unreachable (it fails closed; state that explicitly).
- Provider-side escalation path with named roles and response expectations.
- Cotsel-side incident owner and the declared-incident trigger.
- Maximum tolerable outage before the handoff route is disabled, and who decides.

### 7. Controlled-environment proof

- Sandbox or controlled-environment run showing authenticated requests and callbacks.
- A forged callback rejected, a replayed callback rejected, a delayed callback recorded without regressing state.
- A provider outage handled fail-closed.
- Artifact paths, hashes, environment identity and run identifiers for each.

## Approval record

| Field                       | Value            |
| --------------------------- | ---------------- |
| Provider                    | _(unset)_        |
| Dossier version             | _(unset)_        |
| Due diligence approved by   | _(unset)_        |
| Contract approved by        | _(unset)_        |
| Data-processing approved by | _(unset)_        |
| State mapping approved by   | _(unset)_        |
| Escalation owner            | _(unset)_        |
| Decision                    | **Not approved** |
| Expiry / re-review date     | _(unset)_        |

## Invalidation

Reopen the dossier and the affected acceptance review when the provider's legal
entity, permissions, service terms, sub-processors, authentication scheme, state
vocabulary, or escalation ownership changes materially, or when a Cotsel-side
control listed above changes what it enforces.

## Residual risk

External provider and bank completion remains outside Cotsel authority. The
controls in this repository make a provider's claims non-destructive, auditable
and impossible to read as progress when they are not — they cannot make the
claims true, and they cannot substitute for the approvals this dossier exists to
record.

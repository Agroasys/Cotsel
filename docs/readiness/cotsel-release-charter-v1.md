# Cotsel release charter v1

## Document control

| Field             | Value                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version           | `1.0-draft.1`                                                                                                                                                 |
| Status            | Draft for Engineering Lead, Product authority and Finance authority review. Not approved.                                                                     |
| Accountable owner | Programme Lead, with Product and Finance authorities                                                                                                          |
| Delivery owner    | Programme Lead and Cotsel engineering lead                                                                                                                    |
| Acceptance owner  | Engineering Lead, Product authority and Finance authority                                                                                                     |
| Governing issue   | [#635](https://github.com/Agroasys/Cotsel/issues/635) — `wp0-charter`                                                                                         |
| Work package      | [#622](https://github.com/Agroasys/Cotsel/issues/622) WP-0, gate E-0                                                                                          |
| Governing source  | Cotsel Production Readiness and Controlled-Pilot Statement of Work, 2 August 2026, SHA-256 `775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb` |
| Programme verdict | **NO-GO**. This document is scope and authority definition. It authorizes no release, rehearsal or pilot.                                                     |

This charter fixes the boundaries that WP-1 through WP-12 are built and accepted against: where truth lives, what
each environment may do, which assumptions hold, what the SOW excludes, and which decisions remain open. It is
the baseline the release manifest ([#636](https://github.com/Agroasys/Cotsel/issues/636)), the governance
controls ([#637](https://github.com/Agroasys/Cotsel/issues/637)) and the golden journeys
([#638](https://github.com/Agroasys/Cotsel/issues/638)) all inherit from.

It records decisions. It does not invent them. Every value this charter cannot derive from the repository or an
existing approved record is marked **Decision required** with a named owner and left blank.

## What this charter fixes and what it does not

| In scope                                                                                                                                                                                                         | Out of scope                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System-of-record boundaries; standing assumptions; SOW exclusions; the four environment definitions and their limits; provider boundaries; data classes; the release identity as currently known; open decisions | Protocol, service, database, infrastructure, observability, assurance, pilot-operation and mainnet implementation. WP-0 records those boundaries; WP-1 through WP-12 build them. |

---

## 1. System of record

Nine domains, nine owners. A service, dashboard or test assertion that contradicts this table is a defect in that
component, not in the boundary. `Enforcement point` names where the boundary is or must be enforced in this
repository; `Open gap` names the issue that currently prevents the boundary from holding.

| ID      | Domain                                  | Authoritative system                                                                    | Explicitly not authoritative                                   | Enforcement point                                                                                                                    | Open gap         |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| AUTH-01 | End-user identity and roles             | Agroasys identity and backend                                                           | Cotsel session cache, frontend profile, unverified token claim | `auth/src` session exchange and `GET /session`; per-route authorization in `gateway/src/routes/`                                     | #676, #677, #694 |
| AUTH-02 | Participant balances and wallet history | Agroasys participant ledger                                                             | Cotsel dashboard projections                                   | ADR-0413 §1; Cotsel exposes one sponsorship route and never posts participant balances                                               | #644, #645       |
| AUTH-03 | Order payment intent and reservation    | Agroasys backend                                                                        | Browser acknowledgement, optimistic frontend retry             | ADR-0413 §3 and §4; service-authenticated, idempotent settlement handoff bound to order, amount, chain, contract, nonce and deadline | #646, #694       |
| AUTH-04 | Escrow execution and fee accrual        | `AgroasysEscrow` on Base, via emitted events                                            | Gateway acceptance, submitted transaction, indexer status      | `contracts/src/AgroasysEscrow.sol` state transitions and `claimableUsdc` accrual                                                     | #639, #640, #648 |
| AUTH-05 | Operator approval and signing           | Gateway audit **plus** the decoded signer response reconciled to the chain result       | Unverified managed-signer response                             | `gateway/src/routes/governance`, `operations`; signer response decoding against canonical intent                                     | #645, #649       |
| AUTH-06 | Chain event truth                       | Canonical Base chain                                                                    | Indexer checkpoint state taken alone                           | `indexer/src/processor.ts`, `eventIdentity.ts`, `persistence.ts` checkpointing                                                       | #651, #652, #653 |
| AUTH-07 | Treasury entitlement and close          | Finalized canonical contract events plus fresh reconciliation evidence                  | Unfinalized event, failed handoff row                          | `treasury/src/core/reconciliationGate.ts`, `ingestion.ts`, `closeReporting.ts`                                                       | #655, #656, #657 |
| AUTH-08 | Fiat and off-ramp completion            | Regulated provider or bank                                                              | Cotsel `CREATED`, `FAILED` or unverified callback state        | `treasury/src/core/treasuryPartnerHandoff.ts`; `docs/runbooks/treasury-to-fiat-sop.md`                                               | #656             |
| AUTH-09 | User-visible settlement status          | Agroasys backend, after confirmed Cotsel evidence, chain state and reconciliation agree | Cotsel or dashboard status shown ahead of reconciliation       | ADR-0413 security invariants; signed idempotent execution callbacks to the Agroasys backend                                          | #675, #679       |

Two consequences follow from this table and are binding on every work package:

- **Cotsel never becomes the participant accounting ledger.** It records settlement and treasury-control truth.
  It is not a custody wallet, bank, off-ramp or ledger of record.
- **Acceptance by one layer is not execution.** A gateway 200, a submitted transaction, an indexer row or a
  provider `CREATED` state is pending until the authoritative system in the row above confirms it.

## 2. Standing assumptions

These hold until a named authority records a change decision. Design and test against them; do not quietly
build past them.

| ID            | Assumption                                                                                                                                                                                          | What invalidates it                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ASSUMPTION-01 | Agroasys remains authoritative for end-user identity, orders, participant ledger and wallet history.                                                                                                | Any Cotsel or frontend component becoming a local authority for one of those domains.                                        |
| ASSUMPTION-02 | Cotsel remains the Base settlement and control subsystem; Cotsel-Dash remains an operator surface. Dashboard presentation state never becomes contract, treasury, reconciliation or provider truth. | An operator action that resolves outside an authenticated service, or a dashboard projection treated as settlement evidence. |
| ASSUMPTION-03 | Base Sepolia is used for engineering and pilot rehearsal only. Base mainnet stays behind a separate, fresh authorization programme (WP-12).                                                         | Any inference of mainnet approval from pilot success, or a promotion path that skips the WP-12 packet.                       |
| ASSUMPTION-04 | External cloud, signer, monitoring, provider and compliance owners supply auditable evidence. A Cotsel issue or assignee cannot self-accept an external authority's control.                        | Cotsel-local evidence substituted for an external producer's artifact or receipt.                                            |

## 3. Exclusions

The SOW is engineering-readiness guidance. It is not, and this charter does not make it, any of the following.

| ID           | Exclusion                                                                                        | Routing                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXCLUSION-01 | No legal advice, regulatory classification, financial-statement audit or certification.          | Named legal, compliance and finance authorities. Repository evidence never substitutes for professional approval.                                    |
| EXCLUSION-02 | The audit did not inspect secrets, production data, private cloud consoles or provider accounts. | Revalidate through authorized owners with redacted evidence. No secret value or production personal data enters an issue, log or the evidence index. |
| EXCLUSION-03 | The SOW does not itself authorize any GitHub, cloud, contract or production change.              | Every mutation needs its own owner, change record, protected environment and gate decision.                                                          |

## 4. Environments

Four environments with hard boundaries between them. Evidence produced in one does not carry into another
without the documented equivalence and reviewer approval defined by
`docs/runbooks/release-candidate-evidence-binding.md`.

| ID     | Environment                  | Permitted                                                                                                                                                                                               | Prohibited                                                               | Current state                                                                                                                                                                                                         |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENV-01 | Local and CI verification    | Node 20, frozen lockfile, all workspaces, PostgreSQL and Redis, Hardhat and Foundry, clean image builds. Unit, contract, schema, build and failure-injection proof.                                     | Any claim of deployed or pilot readiness.                                | Operating. `.github/workflows/release-gate.yml`. Runs must carry an explicit non-deployed classification.                                                                                                             |
| ENV-02 | Private Base Sepolia staging | Current-release integration and operational rehearsal in one private control plane with managed database and Redis, KMS or MPC, primary and fallback RPC, protected deployment, monitoring and restore. | **Public users. Real commercial value.**                                 | **Not satisfied.** The present runtime is a single VM driven by `scripts/cotsel.sh` with `.env.runtime` — not a production-like control plane. Owned by WP-7 ([#667](https://github.com/Agroasys/Cotsel/issues/667)). |
| ENV-03 | Controlled pilot             | Named users, bounded value, supervised journeys, all Section 13 gates, allowlists, caps, staffed on-call and support, incident and rollback authority.                                                  | Automatic expansion. Unnamed participants. Value above the approved cap. | **Not authorized.** Participants, jurisdiction and caps are DEC-02, owned by WP-11 ([#684](https://github.com/Agroasys/Cotsel/issues/684)).                                                                           |
| ENV-04 | Base mainnet                 | Production settlement after separate approval, independent assurance, a verified current contract, protected release and live drills.                                                                   | **Any promotion from the pilot by assumption.**                          | **Not authorized.** Requires a fresh WP-12 packet with four-role approval ([#690](https://github.com/Agroasys/Cotsel/issues/690)).                                                                                    |

The ENV-02 gap is the single largest distance between this charter and a rehearsal. Nothing in WP-1 through WP-6
can produce ENV-02 evidence until WP-7 provisions the platform.

## 5. Release identity as currently known

The candidate manifest contract defined by #636 (`integration/candidate-manifest.schema.json`) is what binds
these values to a specific run. This section records what is pinned today and what is not.

| Dimension             | Value                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Chain (rehearsal)     | Base Sepolia, chain ID `84532`                                                                                                     |
| Chain (production)    | Base mainnet, chain ID `8453` — separately gated by WP-12, no deployment authorized                                                |
| USDC (Base Sepolia)   | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                                                                                       |
| Escrow contract       | **Unpinned.** See the note below.                                                                                                  |
| Trade states          | `LOCKED=0`, `IN_TRANSIT=1`, `ARRIVAL_CONFIRMED=2`, `FROZEN=3` (`sdk/src/types/trade.ts`)                                           |
| Cross-repository pins | `integration/release-manifest.json`, status `candidate` — `agroasys-backend@develop`, `platform.v1@main`, `Cotsel.dash@main`       |
| Callback contracts    | `cotsel.settlement-callback.v1`, `cotsel.settlement-observed-amounts.v1`                                                           |
| Provider mode         | **Decision required.** Depends on DEC-01 and the WP-11 participant decision. No provider mode may be assumed from a local default. |
| Cloud and region      | **Decision required.** DEC-01, below.                                                                                              |

**Escrow contract identity is not pinned, and the recorded deployment is stale.** The Base Sepolia deployment
recorded in `contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json` is
`0x8e1e152167FeD9FF7833156A023fFCa88f243B3d`, deployed from commit `1f54c7a`. `AgroasysEscrow.sol` has since
changed on `main` under [PR #618](https://github.com/Agroasys/Cotsel/pull/618) (`13b1410`, admin quorum floor for
the immutable lock). The deployed bytecode therefore does not match the current source, and the recorded ABI and
bytecode digests in that report cannot identify a current candidate. Pinning the contract is owned by
[#639](https://github.com/Agroasys/Cotsel/issues/639). Until it lands, no candidate manifest can be issued and
no journey can be bound to a contract address.

## 6. Provider and data boundaries

**Providers.** Fiat and off-ramp completion is provider- or bank-owned truth (AUTH-08). Cotsel records a bounded
request and reference only. `CREATED`, `FAILED`, duplicate, delayed and conflicting callbacks cannot close a
handoff. The operational contract is `docs/runbooks/treasury-to-fiat-sop.md`; the compliance decision contract,
including the fail stance for each category and the outage stance, is
`docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`.

**Data classes.** The four classes in `docs/security/data-classification-policy.md` —
`public_operational`, `internal_operational`, `confidential_regulated`, `restricted_secret` — apply to every
artifact this programme produces, including the evidence index and every gate record. `restricted_secret` never
appears in a log, runbook, issue or evidence artifact. `confidential_regulated` appears in reference-only, hashed
or masked form. Enforcement is `scripts/tests/data-classification-guard.mjs` in the release gate.

**Async and storage boundary.** There is no queue infrastructure in this repository. Service-to-service calls are
direct HTTP with HMAC authentication and operational state persists in PostgreSQL. **Redis is used for rate
limiting, short-lived locks and nonces only, and is never settlement truth.** Any design that treats Redis as
durable settlement state is out of contract; durable leased work is owned by
[#646](https://github.com/Agroasys/Cotsel/issues/646).

## 7. Open decisions

None of these can be derived from the repository. Each blocks the acceptance named in its row.

### DEC-01 — Authoritative cloud and control plane

**Decision required. Owner: Programme Lead with Engineering Lead. Blocks: #636 producer, WP-7 (#667), ENV-02.**

Select one cloud and control plane for the first integrated staging path. The first production-like rehearsal
must not be split across clouds, and the choice must be consistent with the upstream Agroasys platform.

| Field                              | Value         |
| ---------------------------------- | ------------- |
| Cloud                              | _Not decided_ |
| Account                            | _Not decided_ |
| Region                             | _Not decided_ |
| Control owner                      | _Not decided_ |
| Network and deployment boundary    | _Not decided_ |
| Rejected alternative and why       | _Not decided_ |
| Consistency with Agroasys platform | _Not decided_ |

Downstream obligation: WP-7 provisions this platform from reviewed IaC and inherits every value above.

### Named authorities

**Decision required. Owner: Executive sponsor.** Every gate in this programme names a role. Until real people are
recorded against these roles, no gate can be accepted and no separation-of-duty rule can be enforced. The
responsibility register that binds these names, with deputies, is owned by
[#637](https://github.com/Agroasys/Cotsel/issues/637).

| Role                         | Holder        | Deputy        |
| ---------------------------- | ------------- | ------------- |
| Programme Lead               | _Not decided_ | _Not decided_ |
| Product authority            | _Not decided_ | _Not decided_ |
| Finance authority            | _Not decided_ | _Not decided_ |
| Engineering Lead             | _Not decided_ | _Not decided_ |
| Release Owner                | _Not decided_ | _Not decided_ |
| Security authority           | _Not decided_ | _Not decided_ |
| Operations reviewer          | _Not decided_ | _Not decided_ |
| Treasury authority           | _Not decided_ | _Not decided_ |
| Incident Commander           | _Not decided_ | _Not decided_ |
| Pilot Owner                  | _Not decided_ | _Not decided_ |
| Product and Integration Lead | _Not decided_ | _Not decided_ |

`docs/owners.md` records review ownership by runtime boundary and remains the guide for code review. It is not
this register: it names surfaces, not accountable decision-makers, and it does not carry deputies or separation
of duty.

### Contributed decisions accepted elsewhere

This charter supplies input to two decisions it may not accept itself.

| ID     | Decision                                                                                  | Primary acceptance route                                                    |
| ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| DEC-02 | Pilot participant class, jurisdiction, values, limits and support model                   | `wp11-participants` — [#684](https://github.com/Agroasys/Cotsel/issues/684) |
| DEC-03 | Protocol governance, and whether the immutable contract design is replaced before mainnet | `wp12-authority` — [#687](https://github.com/Agroasys/Cotsel/issues/687)    |

## 8. Coverage

Every control for which #635 is the primary acceptance route, and the section that satisfies it.

| Control            | Section                 | State                                         |
| ------------------ | ----------------------- | --------------------------------------------- |
| AUTH-01 … AUTH-09  | 1. System of record     | Specified; deployed proof owned by WP-9       |
| ASSUMPTION-01 … 04 | 2. Standing assumptions | Specified                                     |
| EXCLUSION-01 … 03  | 3. Exclusions           | Specified                                     |
| ENV-01             | 4. Environments         | Specified; operating                          |
| ENV-02             | 4. Environments         | Specified; **not satisfied**, owned by WP-7   |
| ENV-03             | 4. Environments         | Specified; **not authorized**, owned by WP-11 |
| ENV-04             | 4. Environments         | Specified; **not authorized**, owned by WP-12 |
| DEC-01             | 7. Open decisions       | **Decision required**                         |

Specification is complete for every row. Acceptance is not: the charter cannot be approved while DEC-01 and the
named authorities are open, because a gate cannot be accepted by an unnamed role and a candidate cannot be built
for an undecided environment.

## 9. Approval

This charter supplies evidence to the candidate-specific **E-0** review. It cannot accept or close E-0.

| Role              | Name          | Decision       | Date           |
| ----------------- | ------------- | -------------- | -------------- |
| Engineering Lead  | _Not decided_ | _Not recorded_ | _Not recorded_ |
| Product authority | _Not decided_ | _Not recorded_ | _Not recorded_ |
| Finance authority | _Not decided_ | _Not recorded_ | _Not recorded_ |

## Change and invalidation rule

Reopen #635 and revise this document when a system-of-record boundary, assumption, exclusion, environment
definition, provider boundary, data class, chain, contract identity, cloud decision or named authority changes
materially. Downstream evidence bound to a superseded charter is not valid evidence, and the affected gates
reopen with it. Base mainnet authorization remains separate from engineering rehearsal and controlled-pilot
authorization.

# Cotsel release charter v1

## Document control

| Field             | Value                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version           | `1.0-two-person.1`                                                                                                                                            |
| Status            | Ready for two-person approval: @Astton records Product and Finance approval; @czpyioe records Engineering approval through the linked pull request.           |
| Accountable owner | Programme Lead @Astton                                                                                                                                        |
| Delivery owner    | Cotsel engineering lead @czpyioe                                                                                                                              |
| Acceptance owner  | @Astton as Product, Finance, Release and Operations; @czpyioe as Engineering and Security                                                                     |
| Governing issue   | [#635](https://github.com/Agroasys/Cotsel/issues/635) — `wp0-charter`                                                                                         |
| Work package      | [#622](https://github.com/Agroasys/Cotsel/issues/622) WP-0, gate E-0                                                                                          |
| Governing source  | Cotsel Production Readiness and Controlled-Pilot Statement of Work, 2 August 2026, SHA-256 `775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb` |
| Programme verdict | WP-0 scope-and-authority baseline. This document does not itself claim a deployment, a completed journey, or a mainnet promotion.                             |

This charter fixes the boundaries that WP-1 through WP-12 are built and accepted against: where truth lives, what
each environment may do, which assumptions hold, what the SOW excludes, and which decisions remain open. It is
the baseline the release manifest ([#636](https://github.com/Agroasys/Cotsel/issues/636)), the governance
controls ([#637](https://github.com/Agroasys/Cotsel/issues/637)) and the golden journeys
([#638](https://github.com/Agroasys/Cotsel/issues/638)) all inherit from.

It records the decisions for the current two-person internal integration. Future deployment and journey evidence is
recorded by the work package that produces it; this charter does not manufacture that evidence early.

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

| ID            | Assumption                                                                                                                                                                                                                                    | What invalidates it                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ASSUMPTION-01 | Agroasys remains authoritative for end-user identity, orders, participant ledger and wallet history.                                                                                                                                          | Any Cotsel or frontend component becoming a local authority for one of those domains.                                        |
| ASSUMPTION-02 | Cotsel remains the Base settlement and control subsystem; Cotsel-Dash remains an operator surface. Dashboard presentation state never becomes contract, treasury, reconciliation or provider truth.                                           | An operator action that resolves outside an authenticated service, or a dashboard projection treated as settlement evidence. |
| ASSUMPTION-03 | Cotsel is being prepared for integration with Agroasys and first operates as a private Base Sepolia pre-production environment for controlled end-to-end testing. It is not yet a standalone public product or real-value settlement service. | Treating an internal test result as proof of a public or real-value service.                                                 |
| ASSUMPTION-04 | External cloud, signer, monitoring, provider and compliance owners supply auditable evidence. A Cotsel issue or assignee cannot self-accept an external authority's control.                                                                  | Cotsel-local evidence substituted for an external producer's artifact or receipt.                                            |

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

| ID     | Environment                  | Permitted                                                                                                                                                                                            | Prohibited                                                               | Current state                                                                                                                                                            |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ENV-01 | Local and CI verification    | Node 20, frozen lockfile, all workspaces, PostgreSQL and Redis, Hardhat and Foundry, clean image builds. Unit, contract, schema, build and failure-injection proof.                                  | Any claim of deployed or pilot readiness.                                | Operating. `.github/workflows/release-gate.yml`. Runs must carry an explicit non-deployed classification.                                                                |
| ENV-02 | Private Base Sepolia staging | Current-release integration and operational rehearsal in one private control plane with managed database and Redis, AWS KMS, primary and fallback RPC, protected deployment, monitoring and restore. | **Public users. Real commercial value.**                                 | Target: the existing Agroasys AWS staging boundary. WP-7 ([#667](https://github.com/Agroasys/Cotsel/issues/667)) supplies the platform evidence for an exact candidate.  |
| ENV-03 | Controlled pilot             | Named users, bounded value, supervised journeys, all Section 13 gates, allowlists, caps, staffed on-call and support, incident and rollback authority.                                               | Automatic expansion. Unnamed participants. Value above the approved cap. | Outside this internal integration baseline. If used later, the decision is recorded in WP-11 ([#684](https://github.com/Agroasys/Cotsel/issues/684)).                    |
| ENV-04 | Base mainnet                 | Production settlement after a separately recorded decision, verified current contract, protected release and live drills.                                                                            | **Any promotion from the pilot by assumption.**                          | Outside this internal integration baseline. If used later, WP-12 records the exact candidate and role decisions ([#690](https://github.com/Agroasys/Cotsel/issues/690)). |

WP-7 supplies the platform evidence for the exact candidate when the internal integration reaches that stage.
This baseline fixes the environment boundary and ownership now; it does not claim that a candidate has already
been deployed into it.

## 5. Release identity as currently known

The candidate manifest contract defined by #636 (`integration/candidate-manifest.schema.json`) is what binds
these values to a specific run. This section records what is pinned today and what is not.

| Dimension             | Value                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Chain (rehearsal)     | Base Sepolia, chain ID `84532`                                                                                                       |
| Chain (production)    | Base mainnet, chain ID `8453` — separately gated by WP-12, no deployment authorized                                                  |
| USDC (Base Sepolia)   | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                                                                                         |
| Escrow contract       | **Not pinned.** Currently recorded deployment is `0x8e1e152167FeD9FF7833156A023fFCa88f243B3d`. See the note below.                   |
| Trade states          | `LOCKED=0`, `IN_TRANSIT=1`, `ARRIVAL_CONFIRMED=2`, `FROZEN=3` (`sdk/src/types/trade.ts`)                                             |
| Cross-repository pins | `integration/release-manifest.json`, status `candidate` — `agroasys-backend@develop`, `platform.v1@main`, `Cotsel.dash@main`         |
| Callback contracts    | `cotsel.settlement-callback.v1`, `cotsel.settlement-observed-amounts.v1`                                                             |
| Participant class     | Two named internal Agroasys test accounts operated by @Astton and @czpyioe. No public or external participants.                      |
| Value caps            | Testnet assets only and zero real commercial value. One test flow is active at a time; no fiat or off-ramp settlement is enabled.    |
| Provider mode         | Fiat off-ramp disabled; AWS KMS signer; managed RPC with primary and fallback endpoints.                                             |
| Cloud and region      | Existing Agroasys AWS staging account and the backend staging region; the exact non-secret identifiers enter the candidate manifest. |

### Escrow contract identity

**This charter does not deploy, redeploy or promote a contract, and no contract change is authorized by WP-0.**
EXCLUSION-03 requires every contract mutation to carry its own owner, change record, protected environment and
gate decision. Deploying a candidate contract, regenerating its evidence bundle and promoting it across all
runtime consumers atomically is owned by [#639](https://github.com/Agroasys/Cotsel/issues/639), and no
deployment performed outside that path may be recorded here as release identity.

The deployment recorded in the repository today, and used by every runtime consumer, is:

| Field                 | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Address               | `0x8e1e152167FeD9FF7833156A023fFCa88f243B3d`                         |
| Deployment tx         | `0x2972491842eef29463d16c9e569284c426feba2cf343b17182708442732e7ff7` |
| Source commit         | `1f54c7a`                                                            |
| Compiler              | `0.8.34`                                                             |
| Basescan verification | Verified                                                             |
| Evidence bundle       | `contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json`   |

That bundle is a deployment record, not candidate evidence, and #639 must replace it rather than annotate it.
Two defects block it from identifying a candidate:

- **Its artifact digests and its deployment do not describe the same event.** `bytecodeSha256` was recorded
  from a later compile than the deployment the bundle describes.
- **It carries no deployment block.** `contract.deploymentBlock` is required by the candidate manifest
  (`integration/candidate-manifest.schema.json`), is read by the protocol health report, and is the start block
  for `INDEXER_START_BLOCK`. The deploy script now emits that field and the receipt status from the deployment
  receipt, so the next controlled deploy produces a bundle that carries them; this one predates that change and
  cannot be corrected by hand without becoming hand-entered prose.

Two further conditions hold for whatever contract #639 pins, and both remain open:

- **Promotion is atomic or it has not happened.** `GATEWAY_ESCROW_ADDRESS`, `ORACLE_ESCROW_ADDRESS`,
  `RECONCILIATION_ESCROW_ADDRESS`, `INDEXER_CONTRACT_ADDRESS` and `INDEXER_START_BLOCK` all move together with
  the deploy report, or the repository states two different contract identities at once. A redeploy is a new
  contract, not an upgrade: no state migrates, and trades already locked on the previous address stay there.
- **The deployed role set is collapsed.** Oracle, treasury, relayer, admin[0] and the deploying key are all
  `0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a`. A single key therefore holds oracle attestation, treasury
  payout, gasless relay and one of three admin approvals. This is the condition
  [#642](https://github.com/Agroasys/Cotsel/issues/642) exists to remove; it is inherited from the rehearsal
  configuration in `env/base-sepolia-deploy.env`. It is a known gap, not accepted risk, and it applies to any
  contract deployed from that configuration.

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

## 7. Decisions for the internal integration baseline

### DEC-01 — Authoritative cloud and control plane

**Approved by the Programme Lead for the current baseline. Engineering implementation is reviewed by the
Engineering Lead.**

The first integrated staging path uses the existing Agroasys AWS control plane. It is not split across cloud
providers and does not introduce a separate personal or Cotsel-owned cloud account.

| Field                              | Value                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Cloud                              | AWS                                                                                                                  |
| Account                            | Existing Agroasys staging account                                                                                    |
| Region                             | The existing Agroasys backend staging region; the exact non-secret identifier is recorded in the candidate manifest  |
| Control owner                      | @Astton (Programme and Release Owner), with @czpyioe as Engineering Lead                                             |
| Network and deployment boundary    | Private Agroasys staging boundary behind the existing Cloudflare and AWS deployment controls; no public participants |
| Rejected alternative and why       | A separate personal account or second cloud provider; it would split ownership, secret rotation and release evidence |
| Consistency with Agroasys platform | Reuses AWS KMS, Secrets Manager, GitHub OIDC and the existing backend staging deployment model                       |

WP-7 provisions the platform from reviewed IaC and inherits every value above.

### Named authorities

**Approved two-person operating model. Owner: @Astton.** The programme has two named participants. They may
hold multiple roles, but an evidence producer never reviews or accepts their own item. The responsibility register
is owned by [#637](https://github.com/Agroasys/Cotsel/issues/637).

| Role                         | Holder   | Deputy   |
| ---------------------------- | -------- | -------- |
| Programme Lead               | @Astton  | @czpyioe |
| Product authority            | @Astton  | @czpyioe |
| Finance authority            | @Astton  | @czpyioe |
| Engineering Lead             | @czpyioe | @Astton  |
| Release Owner                | @Astton  | @czpyioe |
| Security authority           | @czpyioe | @Astton  |
| Operations reviewer          | @Astton  | @czpyioe |
| Treasury authority           | @Astton  | @czpyioe |
| Incident Commander           | @Astton  | @czpyioe |
| Pilot Owner                  | @Astton  | @czpyioe |
| Product and Integration Lead | @Astton  | @czpyioe |

For every evidence entry, @czpyioe produces technical and security evidence and @Astton reviews it as Release
Owner or Operations Reviewer; @Astton produces programme, product, finance or operations evidence and @czpyioe
reviews it as Engineering Lead or Security authority. A third participant is not required.

`docs/owners.md` remains the guide for code review by runtime boundary. This register records the two named
decision-makers and their recusal rule.

### Contributed decisions accepted elsewhere

This charter supplies input to two decisions it does not replace. DEC-02 is settled for the current internal
integration baseline and is recorded in WP-11 for traceability; DEC-03 remains a future mainnet decision.

| ID     | Decision                                                                                  | Primary record                                                              | Current baseline decision                                                                                 |
| ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| DEC-02 | Internal participant class, values and support model                                      | `wp11-participants` — [#684](https://github.com/Agroasys/Cotsel/issues/684) | Two named internal operators only; testnet assets, zero real commercial value and disabled fiat off-ramp. |
| DEC-03 | Protocol governance, and whether the immutable contract design is replaced before mainnet | `wp12-authority` — [#687](https://github.com/Agroasys/Cotsel/issues/687)    | No. Gated by WP-12, separately from pilot authorization.                                                  |

This decision does not add a controlled pilot. Any later expansion records its new participant and value decision
in WP-11 before that expanded scope is used.

## 8. Coverage

Every control for which #635 is the primary acceptance route, and the section that satisfies it.

| Control            | Section                 | State                                                                                    |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| AUTH-01 … AUTH-09  | 1. System of record     | Specified; deployed proof owned by WP-9                                                  |
| ASSUMPTION-01 … 04 | 2. Standing assumptions | Specified                                                                                |
| EXCLUSION-01 … 03  | 3. Exclusions           | Specified                                                                                |
| ENV-01             | 4. Environments         | Specified; operating                                                                     |
| ENV-02             | 4. Environments         | Boundary and owner recorded; candidate platform evidence owned by WP-7                   |
| ENV-03             | 4. Environments         | Outside this internal integration baseline; any later expansion is owned by WP-11        |
| ENV-04             | 4. Environments         | Outside this internal integration baseline; any later mainnet decision is owned by WP-12 |
| DEC-01             | 7. Decisions            | Recorded for the existing Agroasys AWS staging control plane                             |
| DEC-02             | 5. and 7.               | Recorded for two named internal, zero-real-value testers                                 |

The WP-0 specification is complete. The linked pull request records the two-person approval of this charter;
future work packages supply their own candidate, platform and journey evidence.

## 9. Approval

This charter supplies evidence to the candidate-specific **E-0** review. It cannot accept or close E-0.

| Role              | Name     | Decision                          | Date       |
| ----------------- | -------- | --------------------------------- | ---------- |
| Engineering Lead  | @czpyioe | Review requested in linked PR     | _Pending_  |
| Product authority | @Astton  | Approved for internal integration | 2026-08-10 |
| Finance authority | @Astton  | Approved for zero-real-value use  | 2026-08-10 |

## Change and invalidation rule

Reopen #635 and revise this document when a system-of-record boundary, assumption, exclusion, environment
definition, provider boundary, data class, chain, contract identity, cloud decision or named authority changes
materially. Downstream evidence bound to a superseded charter is not valid evidence, and the affected gates
reopen with it. Base mainnet authorization remains separate from engineering rehearsal and controlled-pilot
authorization.

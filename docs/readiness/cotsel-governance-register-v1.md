# Cotsel governance register v1

## Document control

| Field             | Value                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version           | `1.0-two-person.1`                                                                                                                                            |
| Status            | Ready for two-person approval: @czpyioe produces this register as Engineering and Security authority; @Astton reviews and accepts it as Programme Lead.       |
| Accountable owner | Programme Lead @Astton                                                                                                                                        |
| Delivery owner    | Cotsel engineering lead @czpyioe                                                                                                                              |
| Acceptance owner  | @Astton, holding the Programme Lead, Product, Finance, Release and Operations authority for the two-person model                                              |
| Governing issue   | [#637](https://github.com/Agroasys/Cotsel/issues/637) — `wp0-governance`                                                                                      |
| Work package      | [#622](https://github.com/Agroasys/Cotsel/issues/622) WP-0, gate E-0                                                                                          |
| Governing source  | Cotsel Production Readiness and Controlled-Pilot Statement of Work, 2 August 2026, SHA-256 `775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb` |
| Programme verdict | WP-0 governance baseline. It installs the rules by which later work is accepted; it accepts nothing by itself.                                                |

This register defines **what each named authority may decide**, how change, defects and evidence
invalidation are controlled, what is reported and how often, and how a work package is accepted. The release
charter ([#635](https://github.com/Agroasys/Cotsel/issues/635)) remains authoritative for **who holds which
role**; this document does not restate that roster and does not change it.

## SOW requirement

| ID        | Required work                                                                             | Implementation requirement                                                                                                                                                                                                                                                           | Acceptance evidence                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GOV-01    | Accept work-package scope                                                                 | Have the Programme Lead accept each work-package scope after Service Owner, Product and Finance review of the complete control sheet and dependency map.                                                                                                                             | The approved nine-field control sheet records the accountable decision, reviewer identities, scope, dependencies, date and affected release or programme state.                                             |
| GOV-02    | Approve protocol and security design                                                      | Have the Engineering Lead approve protocol and security design after Protocol, Security and Finance review of the design, threat and abuse analysis and test plan.                                                                                                                   | A versioned design record links the threat and abuse review and verification plan and records all required reviewer and Engineering Lead decisions.                                                         |
| GOV-03    | Promote to staging                                                                        | Allow the Release Owner to promote to staging only after Platform, Security and Data review of the signed manifest, green required gates and protected deployment.                                                                                                                   | The promotion record ties the signed manifest and required runs to the protected environment and records Release Owner and reviewer approval.                                                               |
| GOV-05    | Accept residual security risk                                                             | Allow only the Security authority to accept residual security risk after affected-owner and Finance or Privacy review. Bound every exception by scope, compensating control and expiry.                                                                                              | A signed risk record names the finding, affected release, owner, reviewers, compensating control, expiry, revocation trigger and Security authority decision.                                               |
| REPORT-01 | Weekly blocker register                                                                   | Publish a weekly blocker register containing evidence links, owner, status, dependency, residual risk and next decision for every unresolved readiness blocker.                                                                                                                      | A dated, versioned register is retrievable, contains every required field, reconciles to live Project items and records reviewer acknowledgement and overdue or escalated decisions.                        |
| REPORT-05 | Decision log for exception, rollback, pause, signer, migration, and limit changes         | Maintain a decision log for every exception, rollback, pause or unpause, signer change, migration and pilot-limit change, including authority, rationale, scope and invalidated evidence.                                                                                            | Sampled and live decisions are append-only, trace to the affected release and issue, contain approval and expiry where applicable, and reconcile to deployment, incident and evidence records.              |
| PROG-03   | Forecast only after WP-0 and a measured deployed rehearsal                                | Issue the first forecast only after WP-0 and one deployed vertical rehearsal, estimate packages with named assumptions and dependencies, report a range and confidence, and reforecast after contract, provider, platform or assurance change. Never trade P0 acceptance for a date. | The approved forecast links WP-0 and rehearsal measurements, states assumptions, dependencies, range and confidence, and the decision log records every required reforecast without waiving a P0 condition. |
| PROG-04   | Accept work by control evidence and dependency state, never by merge or issue state alone | Organize delivery by control outcome, allow parallel work only where dependencies permit and never accept a package from code merge, issue state or narrative alone.                                                                                                                 | The dependency graph and live Project state show no premature acceptance, and every accepted package links complete release-bound evidence and the named acceptance decision.                               |

## 1. Decision rights

Each row states the only authority that may record the decision, who must review first, and the artifact that
holds the decision. A decision recorded anywhere else is not a decision. Role holders are named in the release
charter §7; in the two-person model one person may hold several of these roles, subject to §2.

| ID     | Decision                            | Deciding authority | Required review before the decision    | Authoritative record                                                             | Safe failure                                                                    |
| ------ | ----------------------------------- | ------------------ | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GOV-01 | Accept a work-package scope         | Programme Lead     | Service Owner, Product, Finance        | The nine-field control sheet in the work-package issue, plus the acceptance note | An incomplete or unreviewed control sheet leaves the package in Evidence Review |
| GOV-02 | Approve protocol or security design | Engineering Lead   | Protocol, Security, Finance            | A versioned design record (ADR or design issue) with threat and abuse analysis   | Unreviewed design blocks implementation of the affected control                 |
| GOV-03 | Promote a candidate to staging      | Release Owner      | Platform, Security, Data               | The promotion record bound to the signed candidate manifest                      | A missing manifest, red gate or unprotected deployment blocks promotion         |
| GOV-05 | Accept a residual security risk     | Security authority | Affected owner, and Finance or Privacy | A signed risk record in the decision log                                         | An unbounded, unexpired or unreviewed exception blocks the affected gate        |

**GOV-01 completeness.** A control sheet is complete only with all nine fields required by SOW Section 9.1:
objective; in scope and out of scope; owner and reviewers; dependencies; implementation; verification;
acceptance evidence; rollback and containment; residual risk. A missing field is a defect in the package, not a
formatting issue.

**GOV-02 scope.** Protocol and security design means any change to externally visible protocol, financial state,
signer rule, data contract or operational control. Refactoring that provably preserves all four is not a design
change and does not need a GOV-02 record.

**GOV-03 preconditions.** All three must hold: the candidate manifest validates against
`integration/candidate-manifest.schema.json`; every required release-gate run for that exact candidate is green;
and the target environment matches an authority profile in `integration/release-authority-profile.json` whose
`promotionPolicy` is not `blocked`. `local-ci` and `base-mainnet` are currently `blocked` by that profile.

**GOV-05 bounds.** Every accepted residual risk names the finding, the affected release and gate, the
compensating control, the accepting authority, an explicit expiry date and the revocation trigger. An exception
without an expiry is void. An expired exception reopens its gate automatically and is not extended by silence.
A Critical defect is never eligible for a GOV-05 exception (§3).

## 2. Separation of duty

The programme has two named participants. They may hold several roles each, but the following rule is absolute
and is what makes the two-person model acceptable in place of a larger review board:

> **An evidence producer never reviews, approves or accepts their own evidence.**

| Evidence produced by   | Reviewed and accepted by                            | Reviewer acts as                                              |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| @czpyioe               | @Astton                                             | Release Owner or Operations reviewer                          |
| @Astton                | @czpyioe                                            | Engineering Lead or Security authority                        |
| CI (`ci/release-gate`) | The human acceptance owner for the affected control | Automated producer; a green run is evidence, never acceptance |

A third participant is not required. Where a role is held by the person who produced the evidence, the decision
passes to that role's deputy as recorded in the charter §7 register. If the producer holds both the role and its
deputy for a decision, that decision cannot be recorded and the affected gate stays blocked until a role holder
changes — this is a stop condition, not an exception.

`integration/release-authority-profile.json` enforces this rule mechanically for private Base Sepolia candidate
approvals and human evidence review, through `evidenceReviewers` and the `named-two-person` promotion policy.

## 3. Defect severity policy

Severity is assigned by the technical owner of the affected subsystem and confirmed by the reviewer for that
evidence. Severity describes the worst credible outcome if the defect reaches a participant, not how hard it is
to fix.

| Severity | Definition                                                                                                                                                                                                              | Effect on gates                                                                             | Exception eligible                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Critical | Participant value can be lost, duplicated or stranded; settlement can advance without authoritative evidence; a privileged action can be taken without authorization; a secret or participant personal data is exposed. | Blocks every gate in the programme, not only the affected one. Stops downstream acceptance. | **No.** Must be fixed and re-evidenced.                  |
| High     | A required control can be bypassed under a named condition; a recovery path is missing or unproven; evidence cannot be reproduced by the other participant; an authorization gap exists without direct value impact.    | Blocks acceptance of the affected scope and any gate that depends on it.                    | Only under GOV-05, with compensating control and expiry. |
| Medium   | Operation degrades but a documented manual containment path works and is proven; correctness of settled value is unaffected.                                                                                            | Does not block a gate. Requires a named owner and a target release.                         | Not applicable; tracked, not excepted.                   |
| Low      | Cosmetic, documentation or ergonomic defect with no control, value or evidence impact.                                                                                                                                  | None.                                                                                       | Not applicable.                                          |

**Acceptance rule.** No package, gate or candidate is accepted while an unresolved Critical or High defect
affects its scope. A High defect covered by a live, unexpired GOV-05 exception counts as bounded rather than
unresolved, and the exception is named in the acceptance record.

**Known gap versus accepted risk.** A defect recorded in a WP-0 document as a _known gap_ is not an accepted
risk. It carries its normal severity and blocks accordingly until it is either fixed or granted an explicit
GOV-05 exception. The collapsed deployed role set recorded in the release charter §5 is a known gap of this
kind, not an exception.

## 4. Change control and evidence invalidation

Evidence is only ever valid for the exact thing it was produced against. A change to any identity dimension
below produces a new candidate, invalidates every evidence item bound to the previous one, and reopens the gates
that consumed it.

| Dimension                     | Source of identity                                                |
| ----------------------------- | ----------------------------------------------------------------- |
| Source commit                 | Git SHA in the candidate manifest                                 |
| Artifact or image digest      | Immutable digest per service in the candidate manifest            |
| Chain ID and contract address | `integration/candidate-manifest.schema.json` contract block       |
| Deployment block              | Contract deploy report; also the indexer start block              |
| Migration identity            | Applied migration set recorded for the candidate                  |
| Environment                   | Authority profile in `integration/release-authority-profile.json` |
| Provider mode                 | Charter §6 provider boundary, recorded per candidate              |
| Redacted configuration digest | Environment report bound to the candidate                         |

Beyond artifact identity, evidence is also invalidated when a **named authority, standing assumption, exclusion,
environment definition or system-of-record boundary** changes materially. That kind of change reopens the WP-0
document that recorded it and every gate bound to it.

**Equivalence.** Reusing evidence across a changed dimension requires a documented equivalence argument approved
by the acceptance owner for the affected control, recorded in the decision log with its revocation trigger.
Equivalence is never assumed and never self-approved.

**Mechanics.** The binding itself is defined and enforced by `wp0-release-evidence`
([#636](https://github.com/Agroasys/Cotsel/issues/636)) through `scripts/check-release-evidence-binding.mjs` and
the runbook `docs/runbooks/release-candidate-evidence-binding.md`. This register supplies the human decision and
revocation record that the runbook defers to; it does not restate the binding rules.

## 5. Reporting

| Report           | Cadence                        | Owner          | Artifact                                           |
| ---------------- | ------------------------------ | -------------- | -------------------------------------------------- |
| Blocker register | Weekly, and on any P0 change   | Programme Lead | `docs/readiness/cotsel-weekly-blocker-register.md` |
| Decision log     | Append-only, on every decision | Programme Lead | `docs/readiness/cotsel-decision-log.md`            |

**REPORT-01 — blocker register.** Every unresolved readiness blocker carries: issue reference, title, owner,
status, affected gate, dependency, evidence link, residual risk, next decision, decision due date, reviewer
acknowledgement, and escalation state. The register is dated and versioned per edition, and reconciles to live
Project 9 items through `scripts/readiness/audit-cotsel-production-readiness-live.mjs`. A blocker whose next
decision is past its due date is marked overdue and escalated to the accountable owner in the same edition.
The initial `2026-W33.1` edition is published in
`docs/readiness/cotsel-weekly-blocker-register.md`. Later editions are appended there; each records its live
Project 9 snapshot time and does not revise an earlier edition.

**REPORT-05 — decision log.** Append-only. Entries are added, never edited or deleted; a superseded decision is
corrected by appending a new entry that names the one it supersedes. Every entry carries: sequence, date, type,
deciding authority, reviewer, scope, rationale, affected release or candidate, affected issues, expiry,
invalidated evidence, and revocation trigger.

Logged decision types: exception (including every GOV-05 residual-risk acceptance), rollback, pause, unpause,
signer change, migration, pilot-limit change, and equivalence acceptance under §4.

**Contributed reports.** Daily pilot reconciliation (REPORT-03) and operational metrics (REPORT-04) are defined
here only by their obligation to exist; they are produced and accepted elsewhere, per §7.

## 6. Forecasting and acceptance

**PROG-03 — forecast rules.**

- No forecast is issued before WP-0 is accepted **and** one deployed vertical rehearsal has been measured.
  At the date of this register neither condition is met, so the programme has no forecast and states none.
- Estimates are made per work package, each naming its assumptions and its dependencies.
- Every forecast reports a **range and a confidence level**. Percentage complete is not used anywhere in this
  programme, in any report, issue or dashboard field.
- Reforecast is required after any contract, provider, platform or assurance change, and each reforecast is
  recorded in the decision log.
- A P0 acceptance condition is never traded for a date. If a date is at risk, scope moves or the date moves.

**PROG-04 — acceptance rule.** A merged pull request, a closed issue, a green CI run or a narrative summary is
not acceptance. A package is accepted only when all of the following hold:

1. Every primary control row is implemented and mapped to at least one evidence artifact bound to the release.
2. Every contributor row has been delivered to its named primary route and is not self-accepted locally.
3. No unresolved Critical or High defect affects the scope (§3).
4. Every dependency in the package's dependency map is itself accepted, or is explicitly recorded as an
   unresolved external dependency that the package does not rely on.
5. The named acceptance owner — who did not produce the evidence (§2) — records an explicit Accepted or
   Rejected decision.

Delivery completion without step 5 leaves the package in Evidence Review. Parallel work across packages is
allowed wherever the dependency map permits it; acceptance order is not.

## 7. Contributed decisions accepted elsewhere

This register defines the obligation and the authority for the rows below. It cannot accept any of them, and it
is not their evidence route.

| ID        | Decision or report                                                                  | Deciding authority                                                                             | Primary route                                                               |
| --------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| GOV-04    | Approve an external pilot                                                           | Pilot Owner, after Engineering, Operations, Treasury, Incident Commander and Compliance review | `wp11-go-no-go` — [#686](https://github.com/Agroasys/Cotsel/issues/686)     |
| GOV-06    | Approve mainnet                                                                     | Executive Launch Authority, after four operational roles plus Security and Compliance review   | `wp12-assurance-go` — [#690](https://github.com/Agroasys/Cotsel/issues/690) |
| GOV-07    | Expand pilot participant or value limits                                            | Pilot Owner, after Finance, Operations, Product and Compliance review                          | `wp11-go-no-go` — [#686](https://github.com/Agroasys/Cotsel/issues/686)     |
| REPORT-03 | Daily pilot reconciliation and incident summary                                     | Pilot Owner and Finance authority                                                              | `wp11-rehearsal` — [#685](https://github.com/Agroasys/Cotsel/issues/685)    |
| REPORT-04 | Capacity, signer, RPC, queue, indexer, reconciliation, treasury and support metrics | Operations and Platform owners                                                                 | `wp8-observability` — [#671](https://github.com/Agroasys/Cotsel/issues/671) |

## 8. Coverage

Every control for which [#637](https://github.com/Agroasys/Cotsel/issues/637) is the primary acceptance route,
and the section that satisfies it.

| Control   | Section                        | State                                                                       |
| --------- | ------------------------------ | --------------------------------------------------------------------------- |
| GOV-01    | 1. Decision rights             | Specified                                                                   |
| GOV-02    | 1. Decision rights             | Specified                                                                   |
| GOV-03    | 1. Decision rights             | Specified; the promotion it governs is owned by WP-7 and WP-9               |
| GOV-05    | 1. Decision rights, 3. Defects | Specified; no exception is approved at programme setup                      |
| REPORT-01 | 5. Reporting                   | Initial `2026-W33.1` edition published; later editions remain weekly        |
| REPORT-05 | 5. Reporting                   | Specified; log opened in `docs/readiness/cotsel-decision-log.md`            |
| PROG-03   | 6. Forecasting and acceptance  | Rules specified; no forecast is issued, and neither precondition is yet met |
| PROG-04   | 6. Forecasting and acceptance  | Specified                                                                   |

This register supplies evidence to the candidate-specific **E-0** review. It cannot accept or close E-0.

## 9. Approval

| Role             | Name     | Decision                    | Date       |
| ---------------- | -------- | --------------------------- | ---------- |
| Engineering Lead | @czpyioe | Produced, not self-accepted | 2026-08-11 |
| Programme Lead   | @Astton  | _Pending review_            | —          |

## Change and invalidation rule

Reopen #637 and revise this register when a named authority, decision right, separation-of-duty rule, defect
severity definition, evidence-invalidation dimension, reporting obligation or acceptance rule changes materially.
Decisions already recorded in the decision log remain valid under the register version in force when they were
made, and the log entry names that version. Base mainnet authorization remains separate from engineering
rehearsal and controlled-pilot authorization.

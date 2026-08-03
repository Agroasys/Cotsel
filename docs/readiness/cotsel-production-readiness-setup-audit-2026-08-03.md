# Cotsel Production Readiness Programme Setup Audit

**Audit date:** 3 August 2026

**Repository:** `Agroasys/Cotsel`

**Programme Project:** [Cotsel Production Readiness and Controlled Pilot](https://github.com/orgs/Agroasys/projects/9)

**Canonical programme issue:** [Agroasys/Cotsel#621](https://github.com/Agroasys/Cotsel/issues/621)

## Executive verdict

The initial programme hierarchy and Project configuration were created, but the first setup audit overstated three controls: complete work-package sheets, exact issue-body verification, and exact milestone-description verification. A source-led re-audit also found two unrouted preservation controls, eight primary-route inconsistencies, generic supporting-control rows, asymmetric gate routing, four omitted cross-cutting programme rules, and array-order ownership for reused issues.

The version-two control-plane repair is merged, synchronized to GitHub, and accepted by the full live audit. The programme setup is complete: 71 managed issues and 15 reused supporting issues are reconciled in Project 9, all managed bodies match the deterministic source-backed renderer, hierarchy and milestones match their contracts, and every Project item is assigned only to `Astton` and `czpyioe`.

This audit concerns programme setup only. It does not claim that SOW implementation, engineering rehearsal, controlled-pilot authorization, or Base mainnet authorization has started or completed. The SOW verdict remains **NO-GO**.

## Governing source

The governing source is `Cotsel Production Readiness-SOW.pdf`, dated 2 August 2026. Its SHA-256 is:

```text
775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb
```

The source has 38 pages. The source contract preserves 58 finding rows:

| Priority        | Finding IDs       |  Count |
| --------------- | ----------------- | -----: |
| P0 blocker      | B-01 through B-19 |     19 |
| P1 prerequisite | H-01 through H-32 |     32 |
| P2 improvement  | I-01 through I-07 |      7 |
| **Total**       |                   | **58** |

Each finding retains **ID**, **Required work**, **Implementation requirement**, and **Acceptance evidence** separately. The validator proves that every finding appears once and remains in its SOW work package.

## Corrected supporting-control model

The repaired model contains 136 supporting controls:

| Control class                                     |   Count | Application                                           |
| ------------------------------------------------- | ------: | ----------------------------------------------------- |
| Issue-routed implementation and decision controls |     114 | One primary route plus explicit evidence contributors |
| Engineering and pilot gate definitions            |      13 | Candidate-specific release-gate review                |
| Work-package control-sheet fields                 |       9 | Every WP-0 through WP-12 parent                       |
| **Total**                                         | **136** |                                                       |

The first 131 controls normalize the SOW's authority, preservation, testing, journey, security, compliance, infrastructure, failure, gate, mainnet, governance, reporting, decision, assumption, exclusion, environment, and work-package tables. Five programme invariants explicitly retain governing prose that the original contract skipped:

- Bind verification to the exact promoted release and configuration.
- Require detection, stop, recovery authority, and reconciliation before resumption.
- Forecast only after WP-0 and a measured deployed rehearsal.
- Accept work by control evidence and dependency state, never merge or issue state alone.
- Define the complete seven-journey matrix before cross-repository acceptance work.

Supporting rows use source-specific implementation requirements and acceptance evidence. They are disclosed as structured paraphrases where the SOW uses different source columns; they are not described as byte-identical source rows.

The coverage contract is the sole routing authority. Route files no longer duplicate control ownership. Contributor rows are rendered separately and state that the contributor cannot self-accept the control.

## Corrected routing

The repair makes the following material corrections:

- `PRES-06` receives a dedicated WP-9 service-authentication issue for shared nonce storage, rotation, caller allowlists, and fail-closed behavior.
- `PRES-10`, `TEST-05`, `TEST-07`, `SEC-06`, `FAIL-12`, `FAIL-15`, and `REPORT-03` are derived into their declared primary issue tables.
- `PRES-05` is accepted through maker-checker with canonicality and handoff contributors.
- `COMP-05` is accepted by the WP-10 control authority with WP-4 implementation contributors.
- `FAIL-16` is accepted through dependency readiness with signer-custody and drill contributors.
- `REPORT-04` is accepted through observability with pilot GO consumption.
- E-0 through E-5 and P-0 through P-6 are release-gate definitions, not implementation-owned controls.
- WPCS-01 through WPCS-09 apply to all 13 work-package parents, not one WP-0 child.

## Corrected work-package control sheets

Every work-package contract now supplies the exact nine SOW fields in the required order:

1. Objective.
2. In scope / out of scope.
3. Owner / reviewers.
4. Dependencies.
5. Implementation.
6. Verification.
7. Acceptance evidence.
8. Rollback / containment.
9. Residual risk.

Primary gate, programme track, milestone, and risk remain useful Project metadata. They appear outside the nine-field control sheet and no longer replace source-required fields.

Each parent identifies a single accountable owner, required reviewers, exact scope and exclusions, dependency inputs, immutable evidence requirements, incident ownership, rollback compatibility, residual exposure, and bounded-exception authority and expiry.

## Verified live hierarchy

The reconciled live hierarchy is:

| Level                        |  Count |
| ---------------------------- | -----: |
| Canonical programme issue    |      1 |
| Work-package parents         |     13 |
| Primary delivery issues      |     57 |
| **Managed programme issues** | **71** |
| Reused supporting issues     |     15 |
| **Project items**            | **86** |

WP-9 increases from six to seven children because service authentication is independently assignable and cannot be safely hidden inside privileged-role exchange.

All managed and reused issues remain assigned only to `Astton` and `czpyioe`. All programme work remains in `Agroasys/Cotsel`. Other repositories and providers are evidence and dependency surfaces; Cotsel cannot self-accept their authority.

## Reused-issue ownership

The 15 reused issues now have one explicit `primaryMetadataRoute` and a reviewed contributor list in `cotsel-production-readiness-supporting-issues.json`. Project metadata no longer depends on the first matching route in array order. Existing milestones remain unchanged unless a separate reviewed decision reclassifies them.

## Milestone contract

The repository now records exact number, title, state, and description for all ten milestones. The live audit deep-compares those four fields. The historical A/B/C weighted-progress workflow no longer overwrites milestone descriptions.

## Issue forms

The five readiness forms now:

- assign `Astton` and `czpyioe` at the form level;
- require source-faithful, control-specific four-column content;
- prohibit generic implementation and evidence boilerplate;
- preserve the exact nine-field WP sheet;
- separate Project metadata from the WP sheet;
- require gate identifier, approvers, stop condition, rollback, residual risk and invalidation;
- separate external current state, dependencies, acceptance criteria, evidence supplier and reviewer; and
- require decision dependencies, blocked work and final decision state.

## Verification contract

The local validator now proves:

- 58 findings with exact B, H and I sequences and one SOW work-package route;
- 136 unique supporting controls with complete source references and control-specific content;
- 114 issue-routed controls with one primary route and valid contributors;
- 13 symmetric release-gate definitions and nine structural WP fields;
- 57 primary delivery routes and the exact work-package distribution;
- no obsolete `controlIds` or overloaded route `gate` field;
- complete WP scope, owner, reviewer, evidence, rollback and residual-risk fields;
- exact control-sheet labels and metadata separation;
- explicit reused-issue metadata ownership;
- exact milestone definitions; and
- form assignment and required-field integrity.

Negative tests prove that unknown routes, duplicate contributors, self-contribution, old boilerplate, implementation-owned gates, obsolete route fields, and incomplete WP sheets fail validation.

The post-synchronization live audit proves:

- complete deterministic body equality for all managed issues, with body hashes and first-difference diagnostics;
- exact hierarchy, milestones, assignees and repository boundary;
- exact invariant Project metadata while allowing Status, Evidence Status, release ID, blocker and date fields to progress; and
- complete pagination of managed issues and Project items.

It also deep-compares the exact 30-field Project schema and every governed single-select option, including the dedicated `Auth/Service` delivery surface required by the WP-9 service-authentication issue. The Project configurator preflights the complete field and option contract before mutation, paginates the item set, preserves populated mutable progress fields, and skips values that already match.

## Live synchronization evidence

The repair was merged through [Agroasys/Cotsel#693](https://github.com/Agroasys/Cotsel/pull/693) after CodeQL, DCO, roadmap policy, dependency security, the complete service matrix, cross-repository compatibility, and the aggregate release gate passed. The live synchronization then:

- created [Agroasys/Cotsel#694](https://github.com/Agroasys/Cotsel/issues/694) as the dedicated `PRES-06` primary route;
- linked issue #694 beneath WP-9 parent #631 and added it to Project 9;
- synchronized the deterministic bodies of all 71 managed issues while leaving the 15 reused issue bodies unchanged;
- applied the invariant metadata contract across all 86 Project items without overwriting populated delivery-progress fields; and
- passed `pnpm readiness:cotsel:audit-live` with 71 primary issues, 13 parents, 57 delivery issues, 15 reused issues, 58 findings, 136 supporting controls, 30 fields, 13 views, ten milestones, exact body comparison, and exact milestone comparison.

The setup audit does not treat those successful checks or synchronization actions as implementation evidence. They prove only that the work-control system faithfully represents the SOW.

## Engineering start rule

The prerequisite control-plane conditions are now met, so engineering may begin from the reconciled issue specifications. Work must still follow the dependency sequence, produce release-bound evidence, preserve independent acceptance authority, and keep the SOW verdict at **NO-GO** until the applicable candidate-specific gates accept one pinned release. Programme setup completion does not authorize the controlled pilot or Base mainnet.

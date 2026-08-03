# Cotsel Production Readiness Programme Setup Audit

**Audit date:** 3 August 2026

**Repository:** `Agroasys/Cotsel`

**Programme Project:** [Cotsel Production Readiness and Controlled Pilot](https://github.com/orgs/Agroasys/projects/9)

**Canonical programme issue:** [Agroasys/Cotsel#621](https://github.com/Agroasys/Cotsel/issues/621)

## Executive verdict

The programme-control setup is complete and live. The source SOW, requirement routes, supporting controls, work-package definitions, issue hierarchy, assignments, milestones, Project fields and views, issue forms, GitHub App configuration, synchronization workflow, and verification scripts are present and reconciled.

This verdict applies only to programme setup. It does not claim that the SOW remediation, engineering rehearsals, controlled-pilot authorization, or Base mainnet authorization is complete. The governing SOW verdict remains **NO-GO** until the applicable release-specific evidence is accepted.

The repository and Project are public under the repository-owner decision recorded for this setup. The accidental “CONFIDENTIAL” wording in the supplied document was not treated as an access restriction.

## Governing source and completeness baseline

The source is `Cotsel Production Readiness-SOW.pdf`, dated 2 August 2026. Its SHA-256 checksum is:

```text
775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb
```

The source contains 38 pages. The machine-readable source contract records all 58 finding rows:

| Priority        | Finding IDs       |  Count |
| --------------- | ----------------- | -----: |
| P0 blocker      | B-01 through B-19 |     19 |
| P1 prerequisite | H-01 through H-32 |     32 |
| P2 improvement  | I-01 through I-07 |      7 |
| **Total**       |                   | **58** |

Each finding preserves four separate fields: **ID**, **Required work**, **Implementation requirement**, and **Acceptance evidence**. The validator proves that every finding appears exactly once in the primary issue-route contract and remains assigned to its SOW work package.

The supporting-coverage contract additionally records 131 unique SOW controls across authority boundaries, preservation rules, test layers, golden journeys, security and compliance controls, infrastructure layers, failure and recovery cases, engineering gates, pilot gates, mainnet conditions, governance decisions, reporting, residual decisions, assumptions, exclusions, environments, and work-package control-sheet requirements.

## Live issue hierarchy

The hierarchy contains 70 primary programme issues, all in `Agroasys/Cotsel`:

| Level                   | Live issues       |  Count |
| ----------------------- | ----------------- | -----: |
| Canonical programme     | #621              |      1 |
| Work-package parents    | #622 through #634 |     13 |
| Primary delivery issues | #635 through #690 |     56 |
| **Total**               |                   | **70** |

The parent-child structure is verified live:

| Work package | Parent | Child issues | Child count |
| ------------ | -----: | ------------ | ----------: |
| WP-0         |   #622 | #635–#638    |           4 |
| WP-1         |   #623 | #639–#643    |           5 |
| WP-2         |   #624 | #644–#650    |           7 |
| WP-3         |   #625 | #651–#654    |           4 |
| WP-4         |   #626 | #655–#658    |           4 |
| WP-5         |   #627 | #659–#661    |           3 |
| WP-6         |   #628 | #662–#666    |           5 |
| WP-7         |   #629 | #667–#670    |           4 |
| WP-8         |   #630 | #671–#674    |           4 |
| WP-9         |   #631 | #675–#680    |           6 |
| WP-10        |   #632 | #681–#683    |           3 |
| WP-11        |   #633 | #684–#686    |           3 |
| WP-12        |   #634 | #687–#690    |           4 |

Every primary issue contains the required four-column SOW table. Each primary delivery issue also contains Outcome, Governing source and traceability, Current verified state, Protected flow and scope, Ownership, Dependencies, Supporting issues, Implementation requirements, Acceptance criteria, Negative and failure cases, Evidence required, Rollback and containment, Residual risk, Non-goals, and Closure and invalidation rule.

The live audit confirms that all 70 primary issues have exactly the two authorized assignees: `Astton` and `czpyioe`. No primary issue is assigned to another account.

## Reused supporting issues

The Project includes 15 existing Cotsel issues as supporting delivery history or adjacent implementation lanes:

```text
#100, #403, #451, #453, #454, #455, #456, #519, #525,
#592, #593, #594, #595, #613, #614
```

These issues were not duplicated or reparented away from existing programme relationships. They are linked through the primary issue bodies and route contract. Closed supporting issues remain In Review with Partial evidence; they are not treated as Accepted merely because they are closed. All 15 supporting issues are assigned only to `Astton` and `czpyioe`.

## GitHub Project control model

Project 9 is public, open, linked to `Agroasys/Cotsel`, and contains exactly 85 items: 70 primary programme issues plus 15 supporting issues.

The Project has 30 fields in total, including GitHub’s default fields and the complete programme-control set:

- Status
- Work Package
- Programme Track
- Primary Gate
- SOW Class
- SOW ID
- Priority
- Work Type
- Delivery Surface
- Evidence Status
- Target Release ID
- Accountable Owner
- Delivery Owner
- Acceptance Owner
- External Dependency
- Risk
- Blocked Reason
- Target Date

No percentage-complete field exists. Every one of the 85 items has populated Status, Programme Track, Primary Gate, SOW Class, SOW ID, Priority, Work Type, Delivery Surface, Evidence Status, Accountable Owner, Delivery Owner, Acceptance Owner, External Dependency, and Risk fields. Every item except the programme root has a Work Package value.

The 13 saved views are:

| View                          | Layout  | Purpose/filter                       |
| ----------------------------- | ------- | ------------------------------------ |
| Executive Authorization       | Board   | P0 work with an applicable gate      |
| P0 Blockers                   | Table   | SOW P0 blockers                      |
| Work Packages                 | Board   | Work-package parents                 |
| Engineering Rehearsal         | Board   | Base Sepolia rehearsal track         |
| Controlled Pilot Gates        | Board   | Controlled-pilot gate reviews        |
| Release Candidate             | Table   | Items with a target release ID       |
| Evidence Review               | Table   | Evidence awaiting acceptance         |
| Cross-Repository Dependencies | Table   | External dependencies                |
| Blocked Work                  | Table   | Blocked items                        |
| Decision Queue                | Board   | Unaccepted decisions                 |
| P1-P2 Register                | Table   | P1 prerequisites and P2 improvements |
| Failure and Recovery Coverage | Table   | Failure and recovery controls        |
| Base Mainnet Register         | Roadmap | Separate mainnet track               |

## Milestone reconciliation

All ten milestones were reviewed against current open and closed work.

| Milestone    | State after audit | Programme treatment                                                               |
| ------------ | ----------------- | --------------------------------------------------------------------------------- |
| Milestone A  | Closed            | Historical PolkaVM work retained for traceability; no current readiness claim     |
| Milestone B  | Closed            | Historical non-custodial integration retained for traceability                    |
| Milestone C  | Closed            | Historical pilot planning; explicitly does not authorize the current pilot        |
| Needs Triage | Open              | Temporary intake only; literal newline escapes removed and routing rule clarified |
| M0           | Open              | WP-0 scope, authority, release identity, evidence identity, and governance        |
| M1           | Open              | WP-1 contract runtime, deployment, governance, and role separation                |
| M2           | Open              | WP-2 through WP-4 transaction, indexing, reconciliation, and treasury integrity   |
| M3           | Open              | WP-9 cross-repository compatibility and golden journeys                           |
| M4           | Open              | WP-5 through WP-11 Base Sepolia and controlled-pilot readiness                    |
| M5           | Open              | WP-12 separate Base mainnet authorization                                         |

The legacy milestone titles remain stable to preserve links and history. Their descriptions and states now distinguish historical completion from current SOW acceptance.

## Reusable issue forms

Five Cotsel-specific issue forms are installed:

- Production-readiness implementation
- Production-readiness decision
- Production-readiness external dependency
- Production-readiness gate review
- Production-readiness work package

Every form preserves the four required SOW columns. Gate reviews require an exact release identity and reviewer declaration. External-dependency issues state that Cotsel coordination cannot self-accept evidence owned by another authority.

## Automation and GitHub App

The repository variable `READINESS_APP_CLIENT_ID` and repository secret `READINESS_APP_PRIVATE_KEY` are configured for the `agroasys-readiness-project-bot` GitHub App. The private key is not committed or printed.

The governance workflow:

- uses SHA-pinned checkout and GitHub App token actions;
- requests Cotsel issue read and organization Project write permissions only;
- validates the source and route contracts before synchronization;
- responds to labelled issue creation or reopening, supports manual dry runs, and runs every six hours;
- adds missing labelled issues to Project 9;
- fills missing Status, Work Type, and Work Package values;
- does not convert a closed issue into Accepted evidence; and
- does not overwrite populated human-controlled Project values.

The current live dry run reports zero pending synchronization actions.

## Verification performed

The following checks pass on Node 20:

```text
pnpm readiness:cotsel:validate
pnpm readiness:cotsel:audit-live
pnpm exec eslint --max-warnings=0 scripts/readiness/*cotsel-production-readiness*.mjs
pnpm exec prettier --check <all changed readiness files>
```

The local contract validator proves:

- 58 findings with the exact B, H, and I sequences;
- 58 unique finding routes with no omission or duplication;
- 56 unique primary issue routes;
- 13 work packages with the exact 4/5/7/4/4/3/5/4/4/6/3/3/4 child distribution;
- 131 unique supporting controls with declared group counts; and
- valid work-package, gate, priority, class, work-type, track, risk, dependency, and delivery-surface values.

The live audit proves:

- 70 exact primary issue titles and bodies;
- the complete two-level sub-issue hierarchy;
- exact assignees and current milestones;
- all 85 Project items and populated control metadata;
- all 30 Project fields and 13 exact view definitions;
- all ten reconciled milestone states and descriptions; and
- the live Project-to-repository link.

## Engineering start rule

Engineering delivery starts with WP-0, then proceeds through the explicit dependency sequence. Teams must revalidate the current branch and deployed state before implementing each issue. They must not infer acceptance from historical milestones or supporting issue closure.

Release-specific E-0 through E-5, P-0 through P-6, and mainnet reviews are not created as permanent generic issues. They are instantiated from the gate-review form only when an exact candidate release, evidence index, environment, contract set, provider modes, and rollback target exist.

The programme root closes only after the applicable SOW requirements and controls are implemented, evidence is complete and accepted for one pinned release, the pilot exits under approved criteria, and any requested Base mainnet launch separately satisfies WP-12. Until then, the honest programme verdict remains **NO-GO**.

# Cotsel programme decision log

## Log control

| Field           | Value                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| Control         | REPORT-05, defined in `docs/readiness/cotsel-governance-register-v1.md` §5 |
| Governing issue | [#637](https://github.com/Agroasys/Cotsel/issues/637) — `wp0-governance`   |
| Owner           | Programme Lead @Astton                                                     |
| Mode            | Append-only                                                                |
| Opened          | 2026-08-11, under governance register `1.0-two-person.1`                   |

## Rules

- **Append-only.** Entries are never edited or deleted. A superseded decision is corrected by appending a new
  entry that names the sequence number it supersedes.
- **One entry per decision.** Sequence numbers are assigned in order and are never reused.
- **Logged types.** Exception (including every GOV-05 residual-risk acceptance), rollback, pause, unpause,
  signer change, migration, pilot-limit change, and equivalence acceptance under governance register §4.
- **Separation of duty.** The deciding authority and the reviewer are different people, per governance
  register §2. An entry naming the same person for both is void.
- **Version binding.** Each entry names the governance register version in force when the decision was made. A
  later register version does not retroactively change a recorded decision.
- **Expiry.** An exception without an expiry date is void. An expired exception reopens its gate automatically
  and is not extended by silence.

## Entry format

| Field                | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| Sequence             | `DL-NNNN`, assigned in order                                           |
| Date                 | ISO date the decision was recorded                                     |
| Type                 | One of the logged types above                                          |
| Deciding authority   | Role and person                                                        |
| Reviewer             | Role and person, different from the deciding authority                 |
| Scope                | What the decision applies to, and what it explicitly does not apply to |
| Rationale            | Why the decision was made                                              |
| Affected release     | Candidate manifest identity, or `none` where no candidate exists yet   |
| Affected issues      | Issue references                                                       |
| Expiry               | Date, or `not applicable` for decision types that do not expire        |
| Invalidated evidence | Evidence rendered stale by this decision, or `none`                    |
| Revocation trigger   | The condition that voids this decision                                 |
| Register version     | Governance register version in force                                   |

## Entries

### DL-0001 — Expand the eligible production-pilot participant class

| Field                | Value                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sequence             | `DL-0001`                                                                                                                                                                                                                                                                                                                                                         |
| Date                 | 2026-09-22                                                                                                                                                                                                                                                                                                                                                        |
| Type                 | Pilot-limit change                                                                                                                                                                                                                                                                                                                                                |
| Deciding authority   | Product and Finance authority @Astton                                                                                                                                                                                                                                                                                                                             |
| Reviewer             | Engineering and Security authority @czpyioe, recorded by approval of the exact head of [PR #838](https://github.com/Agroasys/Cotsel/pull/838)                                                                                                                                                                                                                     |
| Scope                | Expands the eligible production-pilot class from the two named internal test accounts to named, candidate-approved, invite-only testing users. It retains Base Sepolia, testnet assets, zero real commercial value, disabled fiat off-ramp, no public self-registration, no automatic expansion, and no public launch. It does not authorize a particular roster. |
| Rationale            | Permit controlled testing with invited users without treating the pilot as a public or value-bearing launch. Candidate-specific P-3 and P-6 decisions remain mandatory before access.                                                                                                                                                                             |
| Affected release     | `none`; no candidate roster or release is authorized by this programme-level scope decision                                                                                                                                                                                                                                                                       |
| Affected issues      | [#622](https://github.com/Agroasys/Cotsel/issues/622), [#635](https://github.com/Agroasys/Cotsel/issues/635), [#684](https://github.com/Agroasys/Cotsel/issues/684), and [#686](https://github.com/Agroasys/Cotsel/issues/686)                                                                                                                                    |
| Expiry               | not applicable                                                                                                                                                                                                                                                                                                                                                    |
| Invalidated evidence | The participant-limit portions of the 2026-08-10 WP-0 charter acceptance and the 2026-W33.1 blocker snapshot, plus any later evidence that assumes only two internal test accounts. Technical evidence unaffected by participant class remains valid only under its own candidate and invalidation rules.                                                         |
| Revocation trigger   | Any unapproved or unnamed participant, public self-registration, automatic cohort expansion, real commercial value, enabled fiat off-ramp, missing candidate-specific P-3 or P-6 acceptance, or another material participant/value boundary change                                                                                                                |
| Register version     | `1.0-two-person.1`                                                                                                                                                                                                                                                                                                                                                |

This entry changes programme scope only. It does not accept P-3 or P-6, deploy a candidate, approve a roster,
or authorize public launch.

## Decisions recorded elsewhere

The baseline decisions below predate this log and are not of a logged type. They are recorded in the artifacts
named here, which remain their authoritative home. They are listed for traceability only; this section is not an
entry list and is not append-only.

| Decision                                                           | Authority                   | Date       | Authoritative record                                                                                                |
| ------------------------------------------------------------------ | --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| DEC-01 — AWS as the authoritative cloud and control plane          | Programme Lead @Astton      | 2026-08-10 | `docs/readiness/cotsel-release-charter-v1.md` §7; accepted at [#635](https://github.com/Agroasys/Cotsel/issues/635) |
| DEC-02 — Two named internal testers, testnet-only, zero real value | Product and Finance @Astton | 2026-08-10 | Charter §5 and §7; recorded for traceability at [#684](https://github.com/Agroasys/Cotsel/issues/684)               |
| Charter approval — Product authority                               | Product @Astton             | 2026-08-10 | Charter §9 approval table                                                                                           |
| Charter approval — Finance authority, zero-real-value use          | Finance @Astton             | 2026-08-10 | Charter §9 approval table                                                                                           |

Work-package scope acceptances under GOV-01, design approvals under GOV-02 and staging promotions under GOV-03
are recorded in their own artifacts as defined by the governance register §1. Only the residual-risk acceptances
they may produce under GOV-05 enter this log.

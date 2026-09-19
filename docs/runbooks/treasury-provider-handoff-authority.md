# Treasury Provider Handoff Authority and Conflict Freeze

What a provider state entitles treasury to do, the append-only rules that keep a
later callback from rewriting an earlier answer, and the approved-exception path
out of a freeze.

- **Owner:** Treasury and Finance owners
- **Traceability:** WP-4, finding B-09 and control FAIL-11 ([Agroasys/Cotsel#656](https://github.com/Agroasys/Cotsel/issues/656))
- **Migration:** `202609190006_provider_handoff_authority`
- **Primary gate:** E-3 (data integrity)

## What the control does

Treasury conflated two questions: **what the provider last said**, and **whether
anything has moved**.

A sweep batch advanced to `HANDED_OFF` whenever it was `EXECUTED`, whatever the
provider had reported — so recording a `CREATED` or `FAILED` handoff marked the
batch handed off and opened realization behind it. Provider state was also
last-write-wins at both levels: `treasury_partner_handoffs.partner_status` and
`partner_handoffs.handoff_status` were overwritten by whichever callback arrived
most recently, with no check that the new state was reachable from the old one.
A delayed `PROCESSING` could regress a `COMPLETED` handoff, and a `FAILED`
arriving after a `COMPLETED` replaced it outright — the record that the
completion had ever been claimed simply stopped existing.

Underneath, the two vocabularies had drifted: the ledger-entry table knew
`PROCESSING` and `RETURNED`, the batch table knew `CREATED` and `ACKNOWLEDGED`,
neither column constrained what could be stored, and nothing anywhere said what
a state _meant_.

| Change                         | Where                                                          | What it guarantees                                                           |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| One vocabulary, one mapping    | `core/providerHandoffAuthority.ts`                             | Every provider state has exactly one authority; unmapped states are refused. |
| Batch advance gate             | `TreasuryController.recordPartnerHandoff`                      | `HANDED_OFF` requires a state that means the instruction left.               |
| Append-only transitions        | `appendTreasuryPartnerHandoffEvidence`, `upsertPartnerHandoff` | A later callback advances, replays or is recorded — never regresses.         |
| Conflict freeze                | `treasury_partner_handoff_conflicts`                           | Two terminal claims freeze the handoff; both are preserved.                  |
| Database-enforced immutability | migration `006`                                                | Evidence cannot be rewritten, and an unmapped status cannot be stored.       |

### Authority, not vocabulary

| Provider state | Authority         | Handed off? | Complete? |
| -------------- | ----------------- | ----------- | --------- |
| `CREATED`      | `NOT_HANDED_OFF`  | No          | No        |
| `SUBMITTED`    | `IN_FLIGHT`       | Yes         | No        |
| `ACKNOWLEDGED` | `IN_FLIGHT`       | Yes         | No        |
| `PROCESSING`   | `IN_FLIGHT`       | Yes         | No        |
| `COMPLETED`    | `COMPLETE`        | Yes         | Yes       |
| `FAILED`       | `TERMINAL_FAILED` | No          | No        |
| `RETURNED`     | `TERMINAL_FAILED` | No          | No        |

`CREATED` is an intent, not a movement. `FAILED` and `RETURNED` are the absence
of one. A provider state Cotsel cannot name is **not** mapped to a default,
because the safe-looking default is the one that reads as progress: it is
refused at the route with `400 ProviderHandoffStateInvalid`, and the database
refuses to store it even if a repair session tries.

`COMPLETED` additionally requires corroboration. A completion is the one claim
that says value left Cotsel's control, so it is refused unless the callback
carries a provider evidence reference or a bank reference. `verified_at` on the
batch handoff is likewise set from evidence, not from the asserted status — it
previously recorded Cotsel's own acceptance of an assertion as verification of
it.

### Transitions

| Classification  | When                                                      | Effect                                                     |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `ADVANCE`       | Forward along the lifecycle, or between in-flight states. | Becomes the authoritative state.                           |
| `REPLAY`        | The same state again.                                     | Idempotent; nothing applied.                               |
| `STALE`         | An older or reordered state.                              | Recorded as evidence; authoritative state unchanged.       |
| `CONTRADICTION` | A second, different **terminal** claim.                   | Handoff frozen; refused with `409`; both claims preserved. |

`ACKNOWLEDGED` and `PROCESSING` share a rank on purpose: providers emit one, the
other, or both, and ranking them would make arrival order decide the
authoritative state.

Delayed and reordered callbacks are expected, not exceptional — a non-terminal
update after a terminal one is `STALE`, not a contradiction. Only two different
terminal claims about one instruction freeze, because only they cannot both be
true.

The callback response reports `transition` and `applied`, so a provider can tell
a delivery that was recorded from one that became authoritative. A provider that
cannot distinguish them will retry a state it already lost.

### Completion is never asserted at creation

`POST /internal/entries/:entryId/partner-handoff` records the _intent_ to hand
off. It runs under internal service auth alone — no provider signature is
involved, and its payload carries no evidence or bank reference for one to be
checked against — so it refuses a `COMPLETED` status outright with
`400 PROVIDER_HANDOFF_STATE_UNKNOWN`. Completion arrives only through the
provider-signed evidence route, where `assertCompletionEvidence` applies.

Without that, an internal caller could write an uncorroborated completion
straight into the authoritative state, and from there into the accounting
projection.

### Every batch callback is recorded

`partner_handoff_events` is the sweep-batch equivalent of the ledger entry's
evidence log, written **before** the callback is classified and carrying the
verdict beside the delivery. Only an `ADVANCE` updates the authoritative
projection; a replayed or reordered delivery is recorded with `applied = false`
and stops there.

That ordering matters for more than the audit trail. A replay used to fall
through to the upsert, where `evidence_reference` and `metadata` were assigned
straight from the incoming payload — so a repeat carrying no receipt erased the
receipt the batch already had. References and metadata now accumulate rather
than being replaced, and a non-advancing delivery does not touch the projection
at all.

### Evidence survives the verdict

The evidence row is written **before** any verdict is reached and is never
conditional on one. What a callback is allowed to _do_ varies; that it arrived,
and what it said, does not. On a contradiction the transaction is **committed
and then** the error is raised — rolling back would discard the very evidence
the conflict is about, leave an unexplained refusal, and let the next identical
callback freeze the handoff all over again.

While frozen, further callbacks are still recorded and still cannot advance the
handoff.

## Applying the migration

`202609190006_provider_handoff_authority` adds CHECK constraints, two nullable
columns per handoff table, one table, and two triggers. The constraints are
satisfied by existing rows because the pinned vocabulary is the **union** of the
two that were previously in use.

One change is not backward compatible with a previous image in the way the
others are: the migration revokes `UPDATE` and `DELETE` on
`treasury_partner_handoff_events` from the runtime role. No current or previous
Cotsel code path updates or deletes that table — it has only ever been inserted
into and selected from — so a mixed-version deployment is safe. The grant is
withdrawn in addition to the trigger because a control that depends only on a
trigger is one `ALTER TABLE ... DISABLE TRIGGER` away from being absent.

```bash
docker compose -f docker-compose.migrations.yml run --rm treasury-migrate
```

## Running the false-completion drill

1. **CREATED and FAILED do not hand off.** Against an `EXECUTED` batch, `POST
/internal/sweep-batches/:batchId/external-handoff` with
   `handoffStatus: "CREATED"`, then `"FAILED"`. Both return `200` and are
   recorded. The batch stays `EXECUTED`; realization stays closed.

2. **A corroborated in-flight state does hand off.** Repeat with
   `"SUBMITTED"`. The batch moves to `HANDED_OFF`.

3. **A completion without evidence is refused.** `POST
/internal/entries/:entryId/partner-handoff/evidence` with
   `partnerStatus: "COMPLETED"` and no `evidenceReference` or `bankReference`
   returns `400`, and the stored status is unchanged.

4. **A reordered callback does not regress.** Send `ACKNOWLEDGED`, then a
   delayed `SUBMITTED`. The second returns `200` with `applied: false` and
   `transition: "STALE"`. Both events appear in
   `treasury_partner_handoff_events`; `partner_status` is still `ACKNOWLEDGED`.

5. **Contradictory terminal evidence freezes.** Send `COMPLETED` with a receipt,
   then `FAILED`. The second returns `409`. Then confirm:
   - `treasury_partner_handoffs.partner_status` is still `COMPLETED`.
   - `frozen_at` and `frozen_reason` are set.
   - Both events are in the evidence log.
   - One `CONFLICT` row exists in `treasury_partner_handoff_conflicts` naming
     the retained and conflicting states and the provider event.

6. **Evidence cannot be rewritten.** `UPDATE` or `DELETE` against
   `treasury_partner_handoff_events` raises `... is append-only`.

7. **Correct through an approved exception.** Establish which claim is true with
   the provider, then record the correction naming the conflict and the
   approval. The correction is **appended**; the conflict row it resolves is
   still there afterwards, which is what makes the history reproducible by
   someone who was not present for the incident. A correction may only settle on
   one of the two states that were actually claimed — anything else would be a
   third, unevidenced assertion about where the money went — and the database
   refuses a correction that names no approving authority.

## Failure handling

| Symptom                            | Cause                                                | Action                                                                   |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `400 ProviderHandoffStateInvalid`  | Provider sent a state with no mapping.               | Map it deliberately in `providerHandoffAuthority`; do not widen blindly. |
| `400` on a `COMPLETED` callback    | No provider or bank evidence attached.               | Provider integration must send its receipt reference.                    |
| `409 PartnerHandoffConflict`       | Contradictory terminal evidence, or frozen.          | Establish the truth with the provider; correct via approved exception.   |
| `applied: false` on every callback | The handoff is frozen.                               | Read `frozen_reason`; the freeze holds until corrected.                  |
| Batch stuck at `EXECUTED`          | Provider reported `CREATED`, `FAILED` or `RETURNED`. | Correct: the instruction has not left. Investigate the provider side.    |

Clearing `frozen_at` directly in the database is not a correction. It discards
the approval record that makes the resolution auditable, and the next
contradictory callback will freeze the handoff again with no history of why the
first one was dismissed.

## Rollback and containment

The code change is a tightening, so a rollback re-opens the defect rather than
causing a new one: a previous image would again advance batches on `CREATED` and
overwrite terminal states. The migration does not need reverting for a code
rollback — the columns are inert to a previous image, and the constraints accept
everything a previous image writes.

If a batch is found to have been marked handed off on a `CREATED` or `FAILED`
provider state, freeze it, re-derive the provider's authoritative state from the
provider's own records, reconcile, and resume only after an approved correction
and a fresh reconciliation result. Incident owner is the Treasury Owner, with
the Incident Commander for a declared incident.

## Verification

```bash
pnpm --filter treasury run typecheck
pnpm --filter treasury run lint
pnpm --filter treasury run test

TREASURY_POSTGRES_TESTS=true pnpm --filter treasury exec jest \
  tests/providerHandoffAuthority.postgres.test.ts --runInBand
```

| Suite                                        | Proves                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `providerHandoffAuthority.test.ts`           | The mapping, the transition rules, and completion evidence.                 |
| `controller.partnerHandoffAuthority.test.ts` | `CREATED`, `FAILED` and `RETURNED` never advance a sweep batch.             |
| `providerHandoffAuthority.postgres.test.ts`  | Freeze, preservation, append-only enforcement, and the approved correction. |

## Scope boundary

This control decides what Cotsel may conclude from what a provider reported. It
does not verify that the provider told the truth — that needs the provider's own
records and, for completion, bank evidence — and it does not decide whether
treasury's chain evidence is current enough to act on at all, which is
[ingestion freshness](./treasury-ingestion-freshness.md).

## Residual risk

External provider and bank completion remains outside Cotsel authority. This
control makes a provider's claims non-destructive and auditable; it cannot make
them true. Independently verifiable provider and bank evidence is still required
before revenue is realized, and the provider due-diligence, contract and
escalation obligations under COMP-06 remain open as an external dependency —
tracked in the
[provider assurance dossier](./treasury-provider-assurance-dossier.md), which
has no approved instance.

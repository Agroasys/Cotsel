# Treasury Maker-Checker Controls

Atomic, actor-bound treasury transitions: row-locked state changes, an
append-only actor chain, authenticated actor identity, and verified provider
callbacks.

- **Owner:** Treasury and Finance owners
- **Traceability:** WP-4, findings H-15, H-16 and PRES-05 ([Agroasys/Cotsel#657](https://github.com/Agroasys/Cotsel/issues/657))
- **Migration:** `202609180003_maker_checker_actor_chain`
- **Primary gate:** E-3 (data integrity)

## What the control does

Two-person control over treasury money rests on two things being true: a
transition happens exactly once, and the actor it is attributed to is the actor
who made it. Neither held before this change.

### H-15 — transitions are atomic

Every maker-checker transition was a read-then-write with nothing between the
read and the write. `updateSweepBatchStatus` read the batch, decided the
transition was legal, then wrote. `updateAccountingPeriodStatus` did the same
with no transaction at all. Two callers could read the same "before" state,
both pass the policy checks, and both write — leaving one approval recorded
under whichever actor committed last.

Each transition now takes the row lock first and carries an expected-state
predicate:

| Transition                        | Lock                                       | Predicate                                            |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Sweep batch status                | `sweep_batches` row `FOR UPDATE`           | `AND status = <observed>`                            |
| Accounting period status          | `accounting_periods` row `FOR UPDATE`      | `AND status = <observed>`                            |
| Sweep allocation                  | `sweep_batches` row `FOR UPDATE`           | Partial unique index on active allocations           |
| Bank confirmation                 | `treasury_ledger_entries` row `FOR UPDATE` | `bank_reference` uniqueness                          |
| Partner handoff create / evidence | ledger entry / handoff row `FOR UPDATE`    | `ledger_entry_id` and `provider_event_id` uniqueness |
| Revenue realization               | `treasury_ledger_entries` row `FOR UPDATE` | `ledger_entry_id` uniqueness                         |

The lock makes the policy checks decide against the state the transaction will
actually write over. The predicate is the second half: a row that no longer
holds the status the decision was made against is not updated, and the losing
caller is told so with `TreasuryConcurrentTransitionError` rather than silently
overwriting.

The idempotent upserts — bank confirmations and partner evidence — retry once
on a unique violation instead of failing. A provider that delivers the same
event twice at the same moment gets the same answer it would get delivering it
twice in sequence: an identical payload is an idempotent replay, a differing
payload is a conflict.

### H-15 — one immutable actor chain

Separation of duty was decided from the mutable `*_by` columns, which only ever
hold the latest actor per role. A batch that went back to `DRAFT` and was
re-prepared by a second maker forgot the first one, and that first maker could
then approve their own batch.

`treasury_transition_actors` records every accepted transition once:

| Column         | Meaning                                      |
| -------------- | -------------------------------------------- |
| `subject_type` | `SWEEP_BATCH` or `ACCOUNTING_PERIOD`         |
| `from_status`  | The state the transition was decided against |
| `to_status`    | The state it moved to                        |
| `actor`        | The authenticated principal that made it     |
| `actor_role`   | `MAKER`, `CHECKER`, `EXECUTOR` or `CLOSER`   |

The table is append-only. The runtime role holds only `SELECT` and `INSERT`,
and the `treasury_transition_actors_immutable` trigger rejects `UPDATE` and
`DELETE` for any writer, including a manual repair session. Evidence that can
be edited is not evidence.

Separation of duty is now evaluated against the whole chain:

- An approver may not hold `MAKER` anywhere in the chain, nor be `created_by`.
- An executor may not hold `CHECKER` anywhere in the chain.
- A closer may not hold `CHECKER` or `EXECUTOR` anywhere in the chain.
- Closing an accounting period requires an actor other than the one who
  requested the close or created the period. This rule did not exist before.

The migration backfills the chain from the existing `*_by` columns, so an
upgraded deployment evaluates against its real history rather than an empty
chain. Backfilled rows carry `metadata.backfilled = true`.

### H-16 — actor identity is authenticated

Every treasury mutation took its actor from the request body. Any holder of one
internal API key could claim to be the maker on one call and the checker on the
next, which defeats the control entirely.

Actor identity is now derived from the authenticated principal, and a
body-supplied actor is an assertion to check rather than a value to trust:

| Situation                                   | Result                              |
| ------------------------------------------- | ----------------------------------- |
| API key bound to a `humanPrincipalId`       | That identity                       |
| API key with no bound human                 | `service:<apiKeyId>`                |
| Body actor matches the principal            | Accepted, the principal is used     |
| Body actor differs, caller may delegate     | `<principal>::<operator>`           |
| Body actor differs, caller may not delegate | `403 ActorMismatch`                 |
| No principal reached the handler            | `401 ActorUnauthenticated`          |
| `AUTH_ENABLED=false` (local development)    | The body actor is required and used |

### Delegated operator identity

Treasury's operator traffic does not arrive from operators. The dashboard
gateway authenticates the human, then calls treasury under its own service key
and carries the operator identity in the body. A strict "body actor must equal
the principal" rule would reject every operator-initiated treasury transition,
and collapsing every operator onto one `service:<apiKeyId>` would make the
second transition in any maker-checker pair look like self-approval.

Callers listed in `TREASURY_OPERATOR_DELEGATION_API_KEYS` may therefore name the
operator they authenticated. The recorded actor names both - for example
`service:treasury-gateway::user-42|0xabc|checker@agroasys` - so a transition is
never attributable to a principal that did not authenticate, and two operators
behind the same gateway key remain distinct actors for separation of duty.

The allowlist defaults to the internal-mutation key set. Narrow it to the one
delegating caller a deployment actually runs, and keep every other internal key
off it: a key on this list can attribute a transition to any operator string,
bounded only by the fact that its own identity is recorded alongside.

**Residual risk.** Delegation moves the trust boundary for operator identity
into the gateway. Treasury can prove which service asserted an operator, not
that the gateway authenticated that operator correctly. Gateway session and
privilege evidence belongs to WP-9 and WP-6 and is not replaced by this
control.

### H-16 — provider callbacks are verified

Cotsel's service key proves that an internal caller relayed a payload, not that
the provider produced it. The two routes that carry external completion
evidence now also verify the provider's own webhook signature:

- `POST /internal/entries/:entryId/partner-handoff/evidence`
- `POST /internal/deposits`

The header follows the `t=<unix-seconds>,v1=<hex>` convention, where `v1` is
HMAC-SHA256 of `<t>.<raw body>` under the partner's webhook secret. The
signature covers the raw bytes, so an accepted payload is the one the provider
signed and not a re-serialized copy of it.

| Rejection code                 | Cause                                           |
| ------------------------------ | ----------------------------------------------- |
| `PROVIDER_SIGNATURE_MISSING`   | No signature header                             |
| `PROVIDER_SIGNATURE_MALFORMED` | Header carries no usable `t` and `v1`           |
| `PROVIDER_SIGNATURE_INVALID`   | Signature does not match the raw body           |
| `PROVIDER_TIMESTAMP_SKEW`      | Signed timestamp outside the window             |
| `PROVIDER_UNKNOWN_PARTNER`     | No webhook secret configured for the partner    |
| `PROVIDER_EVENT_ID_MISSING`    | Callback carries no provider event id           |
| `PROVIDER_EVENT_ID_MISMATCH`   | Header event id differs from the signed payload |

Replay is contained by two layers rather than a consumed nonce: the signed
timestamp bounds how long a captured callback stays usable, and the durable
`provider_event_id` uniqueness makes a re-delivered event resolve to the record
it already wrote. A one-shot nonce would reject the provider's own
at-least-once retries, so it is deliberately not used here.

The partner is identified from `partnerCode` in the signed payload, or from the
`x-webhook-partner` delivery header when the payload names none. Neither
present means no configured secret can apply, and the callback is refused
rather than guessed at.

## Configuration

| Variable                                      | Default                 | Meaning                                                  |
| --------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| `TREASURY_OPERATOR_DELEGATION_API_KEYS`       | internal-mutation keys  | Callers permitted to name an operator they authenticated |
| `TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED`     | `AUTH_ENABLED`          | Verify provider callbacks. Must be true in production.   |
| `TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON`      | empty                   | `[{"partnerCode","keyId","secret"}]`, secret ≥ 32 chars  |
| `TREASURY_PROVIDER_CALLBACK_MAX_SKEW_SECONDS` | `AUTH_MAX_SKEW_SECONDS` | Signed-timestamp window                                  |

Several entries may share a `partnerCode`, which is how a secret is rotated:
add the new secret, let both verify, then remove the old one.

With verification enabled and no secrets configured every provider callback is
rejected, and the service logs a warning naming that effect at startup. This is
the safe direction, but it is an outage for the affected partner — configure the
secret before enabling the partner's deliveries.

## Rollback and containment

Freeze affected batches, preserve conflicting evidence, revoke orphan
eligibility, and resume only after approved correction and fresh reconciliation.

- A rejected transition writes nothing: the chain row commits with the
  transition it belongs to, so a rolled-back transition leaves no approval
  behind.
- `treasury_transition_actors` cannot be corrected in place. A wrong attribution
  is remediated by recording the correcting transition, not by editing history.
- Reverting migration `202609180003` drops the chain and returns separation of
  duty to the `*_by` columns, reopening the superseded-preparer bypass. Treat it
  as a control regression that reopens E-3, not as a routine rollback.

## Verification

```bash
# Unit and route coverage (no database required)
pnpm --filter treasury exec jest tests/actorIdentity.test.ts tests/providerCallbackAuth.test.ts \
  tests/providerCallbackRoutes.test.ts tests/controller.actorBinding.test.ts --runInBand

# Two-connection race and role-separation evidence (requires PostgreSQL)
TREASURY_POSTGRES_TESTS=true pnpm --filter treasury exec jest \
  tests/makerCheckerConcurrency.postgres.test.ts \
  tests/makerCheckerRoleSeparation.postgres.test.ts --runInBand
```

The concurrency suite drives two real connections and asserts that exactly one
of a conflicting pair commits and that one actor chain remains behind it. A
single-connection test cannot observe a lost update, so mocked coverage is not
accepted as evidence for H-15.

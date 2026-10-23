# Transaction finality model

Status: implemented for SDK, gateway and Oracle consumers (WP-2 H-02, #648).
Version: `cotsel.transaction-finality.v1` (`TRANSACTION_FINALITY_MODEL_VERSION`).
Source: `sdk/src/finality.ts`.

## Purpose

Cotsel services each persist their own transaction statuses. Before this model,
they did not agree on when a transaction counts as final. One consumer, the
gateway governance monitor, reported `finalized` and `executed` after five
blocks from head, while the chain's `finalized` tag can sit well behind that on
Base. This model gives every service one vocabulary and one classifier. It also
names the only evidence that counts as final.

The model describes chain truth about a transaction Cotsel broadcast or
observed. It does not change escrow economics, contract behaviour, event
signatures or who owns which truth.

## States

| State       | Meaning                                                                              | Final when                                 |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `submitted` | The send was accepted; no receipt is observed yet.                                   | never                                      |
| `confirmed` | Successful receipt in a canonical block above the `safe` tag.                        | never                                      |
| `safe`      | Successful receipt at or below the `safe` tag, above `finalized`.                    | never                                      |
| `finalized` | Successful receipt at or below the `finalized` tag.                                  | always                                     |
| `reverted`  | Receipt with status 0.                                                               | its block is at or below `finalized`       |
| `replaced`  | A different transaction consumed the same sender nonce.                              | the replacement is at or below `finalized` |
| `unknown`   | The evidence is ambiguous, contradictory, on the wrong chain or no longer canonical. | never                                      |
| `failed`    | Provably never broadcast (rejected before the send).                                 | always                                     |

Only `finalized` with `final: true` is settled success (`isFinalizedSuccess`).

## Classification rules

`classifyTransactionFinality` takes the expected chain, how the submission
ended (`rejected`, `broadcast` or `ambiguous`) and one observation per
provider. Each observation holds the receipt, the canonical block hash at the
receipt height, and the latest, `safe` and `finalized` heads.

- **Wrong chain.** If any provider reports another chain ID, the result is
  `unknown/wrong_chain`.
- **Invalid observation.** A tag ahead of the head, `finalized` ahead of
  `safe`, a receipt ahead of the head or a malformed hash gives
  `unknown/invalid_observation`.
- **Reorganization.** If the receipt's block hash differs from the provider's
  canonical block at that height, or that block cannot be read, the result is
  `unknown/receipt_not_canonical`.
- **Provider disagreement.** Providers must agree on whether a receipt exists
  and on its block number, block hash and status. Any difference gives
  `unknown/provider_disagreement`.
- **Weakest depth wins.** Among agreeing providers, the result takes the lowest
  depth any of them reports.
- **Tag support.** `safe` and `finalized` come only from the chain's own block
  tags. If a provider rejects a tag (`'unsupported'`) or returns no block, the
  model never substitutes a confirmation count. A receipt stays `confirmed`,
  with reason `finality_tag_unsupported` when the `finalized` tag is
  unsupported.
- **Minimum providers.** `minimumProviders` sets how many distinct providers
  must agree before anything above submission is reported.
- **Rejected submissions.** A `rejected` submission is `failed` only when no
  provider has a receipt or replacement for it. Otherwise the result is
  `unknown/contradicts_rejection`.

## Transition rules

`canTransitionTransactionFinality(from, to)`:

- A final position never moves.
- `failed` can only be an initial position. A transaction that may have
  reached the network never becomes "never broadcast".
- Successful depth only rises: `confirmed` → `safe` → `finalized`. To drop to
  a lower depth, the state must pass through `unknown` first.
- A non-final `reverted` or `replaced` may become final, or may go back to
  `unknown` after a reorganization.

## Consumer mapping

| Consumer                      | Persisted status                                                                            | Model position                                                                                                      | Where                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| SDK confirmation stage        | `INDEXED` / `SAFE` / `FINALIZED`                                                            | `confirmed` / `safe` / `finalized` (final)                                                                          | `finalityFromConfirmationStage`           |
| Treasury export eligibility   | requires `FINALIZED` stage                                                                  | `finalized` only                                                                                                    | `isTreasuryConfirmationStage` (unchanged) |
| Oracle trigger                | `CONFIRMED` + `FINALIZED` stage                                                             | `finalized` (final)                                                                                                 | `oracle/src/core/trigger-finality.ts`     |
| Oracle trigger                | `CONFIRMED` without `FINALIZED`, `SUBMITTED` without hash, claimed dispatch with no outcome | `unknown`                                                                                                           | same                                      |
| Oracle trigger                | `SUBMITTED` with hash                                                                       | `submitted`                                                                                                         | same                                      |
| Gateway settlement execution  | `confirmed` / `reverted`                                                                    | `finalized` / `reverted` (final; written only with dual-provider finalized evidence or a finalized Oracle position) | `gateway/src/core/settlementFinality.ts`  |
| Gateway settlement execution  | `broadcast_unknown`, `confirmation_pending`                                                 | `unknown`                                                                                                           | same                                      |
| Gateway settlement execution  | `failed`, `rejected`                                                                        | `failed` (final, pre-broadcast only)                                                                                | same                                      |
| Gateway gasless outcome       | `broadcast_pending`                                                                         | `unknown` (persisted before the send)                                                                               | same                                      |
| Gateway governance monitoring | `pending_confirmation` / `confirmed` / `finalized`                                          | `submitted` / `confirmed` / `finalized`                                                                             | `governanceActionFinality`                |
| Gateway governance monitoring | `reverted` with status `broadcast` / `failed`                                               | `reverted` non-final / final                                                                                        | same                                      |

The indexer reads at the `finalized` tag and refuses to start when the tag is
unsupported (`indexer/src/chainReadiness.ts`). Reconciliation bounds coverage
at a finalized block (`reconciliation/src/core/financialCoverage.ts`). Both
already use the model's evidence rule, so neither needed a mapping change.

## Behaviour changes in this version

1. **Governance monitor.** `executed`/`finalized` now requires the `finalized`
   tag to cover the receipt block. The five-block `finalizationDepth` option
   is gone. The monitor also checks that the receipt block is still canonical,
   and ignores evidence from the wrong chain. A revert becomes the terminal
   `failed` status only once it is finalized. Before that the action stays
   `broadcast` with monitoring state `reverted` and is still monitored. Each
   monitoring audit entry records `finalityModelVersion`, `finalityState` and
   `finalityReason`.
2. **Oracle API.** Trigger execution responses and trigger listings carry
   `finality: { modelVersion, state, final } | null`.
3. **Gateway Oracle progression.** An Oracle `CONFIRMED` status is recorded as
   `confirmed` only when it carries a finalized position in the same model
   version. Otherwise it is recorded as `submitted`, together with the
   reported Oracle status and finality.
4. **Settlement state machine.** `broadcast_unknown` and `submitted` can no
   longer move to `failed` or `rejected`. A conformance test checks every edge
   of the table against the shared transition rules.

## Rollout and rollback

- **Deploy order:** SDK first (it is a workspace dependency), then Oracle,
  then gateway. If the gateway is deployed before the Oracle, Oracle
  `CONFIRMED` responses are recorded as `submitted`. That is the safe
  direction: nothing is promoted. Deploy the Oracle first so that this window
  does not occur.
- **No schema migration.** Every persisted value already exists. Governance
  rows are not rewritten.
- **Legacy rows.** Governance actions marked `executed` under the old depth
  rule before this change are not re-evaluated. Before relying on such an
  action, check its receipt block against the `finalized` tag.
- **Rollback:** redeploy the previous gateway and Oracle images. The previous
  gateway ignores the Oracle `finality` field. While a non-final revert is
  pending, rolling back the gateway resumes the old immediate-`failed`
  behaviour for that action.

## Known limits

- The governance verifier observes through one managed failover provider
  (`minimumProviders` 1), so it cannot detect provider disagreement. The
  gasless path already requires two independent providers. Adding a second
  governance witness is a configuration and evidence decision for WP-7
  INFRA-05.
- Replacement detection takes the replacement's block from the observation.
  No producer reports `replaced` yet, so it is never mapped as final.
- `POST /settlement/handoffs/{handoffId}/execution-events` still lets an
  authenticated service caller assert `confirmed` without attaching finality
  evidence. The state machine still prevents an ambiguous broadcast from
  being overwritten as `failed`.
- Acceptance still requires candidate-bound evidence from the deployed
  environment (issue #648). Local tests cover the model's logic only.

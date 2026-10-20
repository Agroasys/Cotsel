# Base Sepolia Gasless Settlement Proof

## Purpose

Prove that gasless settlement v1 works on Base Sepolia before any mainnet rollout.
This proof is specifically about user friction: buyers and suppliers must not need
ETH for the default create-trade, supplier-payout, or buyer-refund paths.

## Required Command

Run the rehearsal packet generator with a deterministic window id:

```bash
pnpm run pilot:rehearsal --window-id <window-id> --bring-up-profile
```

For CI or repo-local validation only:

```bash
pnpm run pilot:rehearsal --window-id <window-id> --config-only
```

Config-only output is not a live Base Sepolia proof. A live proof requires the
generated packet under `reports/base-sepolia-pilot-validation/<window-id>/` to be
completed with real transaction, relayer, treasury, and reconciliation evidence.

## Required Live Flows

1. Buyer deposit / create trade:
   - buyer authenticates through Agroasys session handling
   - buyer signs with Web3Auth wallet
   - buyer wallet does not need or spend ETH for the action
   - relayer submits the gasless action
   - escrow emits the create-trade/funding evidence

2. Supplier payout:
   - supplier wallet does not need or spend ETH for the action
   - payout transfers directly to the supplier wallet
   - no supplier `claim()` transaction is required

3. Buyer refund:
   - exercise one dispute or timeout refund path
   - buyer wallet does not need or spend ETH for the refund
   - refund transfers directly to the buyer wallet
   - no buyer `claim()` transaction is required

## Accounting And Reconciliation Evidence

The packet must include:

- relayer request id, idempotency key, and tx hash for each sponsored action
- gas spend record for each sponsored action
- indexer events for relayed execution, supplier payout, and buyer refund
- treasury ledger entries for logistics, net platform fee, and settlement support fee
- reconciliation report proving gross platform fee and split fee components agree
- explicit note that reconciliation did not depend on transaction sender as buyer/supplier proof

## Failure Handling

Exercise and record:

- expired authorization rejection before fund movement
- repeated failed submission without duplicate settlement
- relayer outage or disabled-relayer behavior
- fallback UX, with ETH top-up treated only as support tooling

The live proof report must include a populated `failureModeEvidence` object:

- `expiredAuthorization.passed=true` and `expiredAuthorization.noTradeCreated=true`
- `idempotentReplay.passed=true` and `idempotentReplay.noDuplicateTradeCreated=true`
- `relayerOutageOrDisabled.status=passed` with structured evidence
- `fallbackUx.status=passed` with structured evidence
- `operatorFailureRehearsal.status=passed` with structured evidence for a
  dropped, stuck, or repeated-failure execution drill

The proof script records expired-authorization and idempotent-replay checks
directly. Operators must provide the outage, fallback UX, and failure rehearsal
JSON evidence files through:

```bash
PILOT_RELAYER_OUTAGE_EVIDENCE_REF=<path-to-relayer-outage-json>
PILOT_FALLBACK_UX_EVIDENCE_REF=<path-to-fallback-ux-json>
PILOT_FAILURE_REHEARSAL_EVIDENCE_REF=<path-to-failure-rehearsal-json>
```

Generate those files with:

```bash
pnpm run gasless:failure-evidence -- \
  --scenario relayer_outage_or_disabled \
  --readiness-file <paused-or-disabled-readiness-response.json> \
  --evidence-ref <durable-run-or-ticket-ref> \
  --no-user-eth-required \
  --output reports/base-sepolia-pilot-validation/<window-id>/relayer-outage.json

pnpm run gasless:failure-evidence -- \
  --scenario fallback_ux \
  --fallback-file <fallback-ux-capture.json> \
  --evidence-ref <durable-run-or-ticket-ref> \
  --no-user-eth-required \
  --output reports/base-sepolia-pilot-validation/<window-id>/fallback-ux.json

pnpm run gasless:failure-evidence -- \
  --scenario operator_failure_rehearsal \
  --readiness-file <stuck-or-repeated-failure-readiness-response.json> \
  --evidence-ref <durable-run-or-ticket-ref> \
  --output reports/base-sepolia-pilot-validation/<window-id>/failure-rehearsal.json
```

The generated JSON must have `status=passed`, a valid `observedAt`, a durable
`evidenceRef`, and the required `checks` for that scenario. Capacity rehearsal
will reject ticket-only or otherwise unstructured references.

## Relayer Operator Controls

Before any live proof is treated as release evidence, record the output from
`GET /api/dashboard-gateway/v1/operations/gasless-relayer/readiness` and verify:

- `GATEWAY_GASLESS_BROADCAST_PAUSED=false` only during the approved execution window
- signer custody is `kms` or `mpc` for production; `raw_private_key` is staging-only unless a time-boxed emergency exception is explicitly approved
- `kms` custody uses `GATEWAY_GASLESS_KMS_KEY_ID` plus the independently approved `GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS` and obtains AWS credentials from the task IAM role; `mpc` custody uses `GATEWAY_GASLESS_MANAGED_SIGNER_URL` plus `GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY`; both modes reject raw gasless executor private-key material
- `GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI` and `GATEWAY_GASLESS_MAX_NATIVE_COST_WEI` are set and below treasury-approved spend caps
- `GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI` is at or above `GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI`, so operators are alerted before the executor reaches the hard no-broadcast floor
- `capacityPolicy.requiredBurstHourBalanceWei` is at or below both `GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI` and `GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI` before production/mainnet launch
- `GATEWAY_RPC_FALLBACK_URLS` contains an independent managed fallback provider when gasless execution is enabled
- executor balance, queue, stuck-queue, low-balance, repeated-failure, and burst-hour capacity policy thresholds are visible in the readiness payload

Emergency pause is `GATEWAY_GASLESS_BROADCAST_PAUSED=true`. When paused, Cotsel
must reject new gasless broadcasts before accepting settlement execution
telemetry, so there is no ambiguous fund-movement state.

## Capacity Rehearsal

Run the deterministic control-plane rehearsal before live traffic:

```bash
pnpm run gasless:capacity -- --mode config-only --stdout
```

For live evidence, attach the populated Base Sepolia proof packet:

```bash
pnpm run gasless:capacity -- --mode live --evidence-file reports/base-sepolia-pilot-validation/<window-id>/live-base-sepolia-proof.json --stdout
```

The release target remains at least 500 user-facing on-chain settlement
transactions/day and $10M/day notional with burst margin. The executor funding
floor is calculated as:

```text
required executor floor =
  ceil(target tx/day * burst multiplier / 24)
  * GATEWAY_GASLESS_MAX_GAS_LIMIT
  * GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI
  * safety margin
```

The default policy uses `GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY=500`,
`GATEWAY_GASLESS_CAPACITY_BURST_MULTIPLIER_BASIS_POINTS=40000` (4x), and
`GATEWAY_GASLESS_CAPACITY_SAFETY_MARGIN_BASIS_POINTS=12500` (1.25x).
`GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED` is optional for staging, but production
and Base mainnet must fail closed when the configured executor balance floor or
low-balance alert threshold does not cover `requiredBurstHourBalanceWei`.

Config-only rehearsal is not live proof; it only verifies that queue, gas-cap,
fallback-provider, spend-threshold, and capacity-policy settings are coherent
before the Base Sepolia run.

Live capacity rehearsal fails closed when the proof packet is missing required
transaction hashes, direct payout/refund deltas, backend ledger reconciliation,
delivered callbacks, service-wallet gas spend, or the required failure-mode
evidence listed above.

## Go / No-Go

Go only when all required live flows pass without requiring or spending user ETH
and the generated `rollout-checklist.md` has no unresolved no-go condition.

No-go if any default buyer, supplier, or buyer-refund path needs user ETH, if
support fee is collapsed into platform fee, if reconciliation has unresolved
CRITICAL drift, or if relayer failure creates ambiguous fund movement.

## Related Runbooks

- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/runtime-release-gate.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/base-mainnet-go-no-go.md`
- `docs/runbooks/base-mainnet-cutover-and-rollback.md`

## Wallet integrity candidate acceptance

The integrity candidate uses `gasless_create_trade_scope_v1` for immutable execution scope.
Verify the complete normalized execution hash and issuing service identity before dispatch.
A new transport hash must not change buyer, supplier, amounts, rail, authorization, or signature.

Apply the handoff-scope and finalized-evidence migrations before candidate startup.
The retained observer requires two RPC witnesses with different hostnames.
Confirm independent provider operation separately; hostname difference alone is insufficient.
Require receipt, canonical block, chain, logs, and common finalized-head agreement.
A mined receipt remains pending until this policy passes.

Retain confirmed outcomes for ongoing canonicality checks.
On unanimous orphaning, emit `chain_evidence_orphaned` and keep the original operation reserved.
The public execution-event ingress cannot create this observer event.
Confirm that Agroasys accepts this callback event before gateway promotion.
Preserve the original event and transaction when accounting requires correction.
Do not rebroadcast or repeat funding to resolve an unknown outcome.

Local Node 22 tests and disposable PostgreSQL checks establish implementation behavior only.
The actual provider project, connection, approved accounts, chain deployment, and protected rollout still require independent acceptance.

## Revision 2 execution and financial confirmation

Audience: staging release operators and settlement reviewers. Scope: candidate implementation evidence before enablement.

New gasless handoffs require `executionBinding` with scope version `agroasys.cotsel-execution-binding.v1`.
The gateway derives `ownerServiceId` from authenticated service credentials. Metadata cannot replace this binding.
A retry must retain the package, operation, authorization, recipient, rail, amount, and execution hash.
Migration `202610150013` preserves legacy missing bindings. These records cannot enter new execution.

Financial confirmation uses the existing indexer probe and reconciliation health server:

1. Apply reconciliation migration `202610150004` before deploying the updated worker.
2. Deploy the updated indexer probe and retained reconciliation worker.
3. Set `GATEWAY_INDEXER_COVERAGE_URL` to the approved internal indexer `/coverage` URL.
4. Set `GATEWAY_RECONCILIATION_COVERAGE_URL` to the approved internal reconciliation `/coverage` URL.
5. Restrict these service probe endpoints to approved internal traffic.
6. Wait for a complete, clean reconciliation run with captured chain evidence.
7. Verify the authenticated gateway transaction-finality endpoint against the exact receipt.

The indexer returns its actual processor checkpoint after its existing readiness checks pass.
Reconciliation returns a retained clean run covering the requested trade at an anchor now covered by finality.
A comparison can qualify after its captured anchor becomes finalized. Older clean evidence cannot bypass newer drift or incomplete runs.
Contained trades, incomplete runs, missing evidence, and expired coverage remain pending.
Both RPC witnesses must independently match the receipt, finalized head, indexer checkpoint, and reconciliation anchor.
The reconciliation anchor must be finalized. Neither latest-block reads nor confirmation counts replace finality.
Legacy runs without captured chain evidence are unproven. Do not synthesize a backfill.

`GET /settlement/transactions/:transactionHash/finality` requires service authentication.
The endpoint returns `503` while matching financial evidence is unavailable.
Agroasys also checks the returned transaction and block identity against its own RPC witnesses.
An issuance pause leaves authenticated reads and the retained outcome observer available.
Do not disable the observer to stop new dispatch.

Local contract probes and disposable PostgreSQL migration proofs do not establish live provider, RPC, or deployed-rail acceptance.

## Original funded progression and durable Oracle dispatch

Audience: release operators and independent settlement reviewers.
Prerequisites: Verified original funded packages, approved deployment manifests, and compatible Agroasys, gateway, SDK, and Oracle versions.
Outcome: Original funded participants and rail remain unchanged through payout submission and retry.

Stop Oracle mutation workers before migrations `202610160002` and `202610160003`.
Apply the Oracle migrations through the retained migration runner.
Migration `202610160003` uses the runner's transaction and a five-second lock timeout.
Its partial unique index requires the Oracle mutation lane to remain stopped during creation.
Apply gateway migration `202610160014` before enabling funded progression registration.
Deploy the compatible SDK and Oracle before enabling gateway progression.

Agroasys builds `agroasys.funded-settlement-binding.v1` from the original finalized funding package.
The gateway checks its issuing service, source handoff, phase, trade, commercial hash, and exact movement amounts.
The gateway retains that complete instruction in its immutable typed binding.
Missing legacy bindings block new financial execution. Do not invent a legacy provider claim or binding revision.

Oracle retains the same binding on its trigger and on governed re-drives.
Before each first submission, independently verify the original funding receipt through two RPC witnesses.
Require its successful receipt, canonical finalized block, exact TradeLocked event, and original buyer-to-escrow USDC movement.
Compare the current contract trade with the original participants and funded breakdown.
Recheck containment before acquiring the durable dispatch claim.

A committed dispatch claim permits one submission for the logical financial action.
Persist an observed transaction hash before waiting for its receipt.
A timeout after the claim remains unresolved. Do not submit again or clear the claim.
The existing confirmation worker continues observing an original submitted hash after its normal observation deadline.
A claimed operation without a hash remains blocked for independent reconciliation.
Application timeouts, worker restarts, status resets, and a new request ID do not prove non-execution.

### Retained deployment configuration

`GATEWAY_RETAINED_SETTLEMENT_RAILS_JSON` defaults to `[]`.
Each approved record requires `chainId`, `escrowAddress`, `usdcAddress`, `rpcUrl`, `rpcFallbackUrls`,
`indexerCoverageUrl`, `reconciliationCoverageUrl`, and `railManifestSha256`.
An observation record alone cannot enable execution.
Add `executionOracleBaseUrl` only after approving that retained Oracle deployment and service authentication.
Use an HTTPS URL without URL credentials or a fragment.
The gateway selects the retained executor by the immutable chain, escrow, and token tuple.
The destination Oracle independently rejects a binding for a different configured deployment.
A request cannot supply an RPC endpoint or executor URL.
Keep retained indexer and reconciliation coverage healthy before confirming any payout financially.

### Local verification commands

Run `pnpm --filter oracle test` for Oracle unit and retry checks.
Run `pnpm --filter gateway test` for gateway and public contract checks.
Build the SDK before running `pnpm --filter @agroasys/shared-db run test:funded-binding:postgres`.
The PostgreSQL proof creates disposable databases on loopback and rejects remote database hosts.
Keep these controlled results separate from actual provider, deployed-chain, and operational acceptance.

## Oracle dispatch exclusion and original confirmation

Apply Oracle migrations `202610160003` and `202610160004` with mutation workers stopped.
Keep original observation available during the compatibility window.
Do not run earlier Oracle mutation workers after this cutover.

Oracle reserves one dispatch per financial action and one unresolved dispatch per chain and signer address.
A transaction hash alone does not release the signer reservation.
Two independent RPC witnesses must establish finalized canonical inclusion of that exact original transaction.
A finalized revert consumes its nonce, but does not prove payment success.
A hashless accepted send remains unresolved and blocks new sends from the same signer.
Unattributed legacy dispatches also block new sends until governed reconciliation establishes their original identity.

Use one coordinated Oracle database for each chain and signer address.
Verify that the signer is not shared with another Oracle database, relayer, external sender, or unmanaged process.
Record this separation in the approved deployment manifest.
The implementation cannot coordinate an undisclosed external user of the same key.

This conservative exclusion permits one unresolved transaction per Oracle signer.
It can limit throughput until finalized evidence becomes available.
Record the approved capacity expectation before cohort enablement.
Do not remove the exclusion to meet a throughput target.

Oracle confirmation requires the original transaction input, funded participants, expected semantic event, actual token movement,
independent finalized block agreement, and matching indexer event.
Advanced trade state, a safe block, and elapsed application time cannot confirm the original operation.
The retained observer preserves unresolved operations after its notification deadline.
Re-drive cannot convert a changed trade state into success or resubmit an earlier accepted transaction.

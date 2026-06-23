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
- managed signer custody uses `GATEWAY_GASLESS_MANAGED_SIGNER_URL`; production also requires `GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY` and rejects raw gasless executor private-key material in managed mode
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

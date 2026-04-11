# Dashboard Local Parity

## Purpose

Provide the upstream Cotsel source of truth for local browser parity prerequisites used by `Cotsel-Dash` live-contract verification.

This runbook defines:

- standard `local-dev` behavior,
- parity-enabled `local-dev` behavior,
- the canonical seeded trade used for dashboard Trade Detail parity,
- the preflight path that must succeed before running dashboard live local-contract verification.

## Mode boundary

- Standard `local-dev`: lightweight mock indexer responder with an empty trade registry.
- Parity-enabled `local-dev`: same profile, but `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity` exposes a seeded trade record for dashboard live parity.

Canonical seeded trade:

- `tradeId`: `TRD-LOCAL-9001`

## Preconditions

- `.env` created from `.env.example`
- `.env.local` created from `.env.local.example`
- Docker Engine with Compose plugin
- Node 20
- Hardhat local chain available through the `local-dev` profile

## Enable parity mode

1. Set the local fixture mode in `.env.local`:

```bash
LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity
```

2. Start the local stack:

```bash
scripts/validate-env.sh local-dev
scripts/docker-services.sh build local-dev
scripts/docker-services.sh up local-dev
```

Optional broad profile check:

```bash
scripts/docker-services.sh health local-dev
```

Parity gate note:

- `scripts/docker-services.sh health local-dev` validates the whole local profile and can fail for services outside the dashboard parity boundary.
- `npm run dashboard:parity:preflight` and `npm run dashboard:parity:gate` are the authoritative upstream parity gate for dashboard live local-contract verification.
- parity gate failures now emit a stable machine-usable error code and non-zero exit for CI-adjacent automation; do not reinterpret the gate as whole-profile health.

3. Deploy the local escrow contract if gateway readiness reports `chain-rpc unavailable`:

```bash
cd contracts
npx hardhat ignition deploy ./ignition/modules/AgroasysEscrow.ts --network localhost
cd ..
```

4. Mint a dashboard operator session artifact:

```bash
export DASHBOARD_SMOKE_PRIVATE_KEY="$(awk -F= '/^ORACLE_PRIVATE_KEY=/{print $2}' .env)"
export DASHBOARD_SMOKE_SESSION_OUTPUT_FILE=/tmp/cotsel-dashboard-session.json
npm run dashboard:parity:session
```

5. Run the upstream parity preflight:

```bash
export DASHBOARD_PARITY_SESSION_FILE=/tmp/cotsel-dashboard-session.json
npm run dashboard:parity:preflight
```

## Expected preflight contract

Successful parity preflight proves:

- auth session resolution works for the dashboard operator session
- gateway `/healthz`, `/readyz`, and `/version` are reachable
- gateway readiness is green against the local stack
- the trade list surface returns the canonical seeded trade `TRD-LOCAL-9001`
- the trade detail surface returns a canonical Base-era payload with at least one `txHash`

## Failure interpretation

- `readyz` reports `chain-rpc unavailable`
  - deploy the local escrow module and rerun preflight
- gateway trade list returns zero trades
  - set `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity`
  - restart `local-dev`
- gateway crashes with stale env contract errors such as `AUTH_BASE_URL is missing`
  - rebuild `local-dev` so gateway runs the current repo image
- gateway trade list returns a different first trade id
  - local parity data is stale or the fixture path is not the canonical parity dataset
- auth session fails
  - mint a fresh session artifact with `npm run dashboard:parity:session`

Stable parity gate failure classes:

- `SESSION_ARTIFACT_INVALID`
- `AUTH_SESSION_REQUEST_FAILED`
- `AUTH_SESSION_PAYLOAD_INVALID`
- `AUTH_SESSION_ROLE_INVALID`
- `GATEWAY_HEALTH_REQUEST_FAILED`
- `GATEWAY_READY_REQUEST_FAILED`
- `GATEWAY_NOT_READY`
- `GATEWAY_VERSION_REQUEST_FAILED`
- `GATEWAY_TRADES_REQUEST_FAILED`
- `GATEWAY_TRADES_PAYLOAD_INVALID`
- `GATEWAY_TRADE_DETAIL_REQUEST_FAILED`
- `GATEWAY_TRADE_DETAIL_PAYLOAD_INVALID`
- `SEEDED_TRADE_MISSING`
- `SEEDED_TRADE_MISMATCH`

## Automation boundary

Supported now:

- manual local parity verification
- pre-release local parity verification before running `Cotsel-Dash` live-contract Playwright coverage
- CI-adjacent parity gating built around `npm run dashboard:parity:gate`, provided the job also mints a fresh admin session artifact and deploys the local escrow contract

Not promoted yet:

- PR-required CI gate

Promotion criteria for CI-adjacent parity:

1. automate local escrow deployment in a bounded job
2. mint an admin session artifact in job scope
3. run `npm run dashboard:parity:gate`
4. then run `Cotsel-Dash` live local-contract browser verification

## CI-adjacent live parity automation

Canonical Cotsel-owned entrypoint:

```bash
npm run dashboard:parity:ci
```

This orchestration path:

- validates `local-dev` env requirements
- requires `LOCAL_DEV_INDEXER_FIXTURE_MODE=dashboard-parity`
- builds and starts `local-dev`
- records broader `scripts/docker-services.sh health local-dev` as advisory whole-profile evidence
- deploys the local escrow contract
- mints a fresh dashboard session artifact
- runs `npm run dashboard:parity:gate`
- runs `Cotsel-Dash` `npm run test:e2e:live`
- writes `reports/dashboard-parity/live-parity-gate.json`

Status boundary:

- `dashboard:parity:gate` remains the authoritative narrow dashboard readiness contract
- broader `health local-dev` remains a separate whole-profile signal and is reported distinctly in the gate report
- a whole-profile health failure must remain visible; it does not automatically invalidate the dashboard parity gate if parity and live browser verification both pass

GitHub Actions source of truth:

- `.github/workflows/dashboard-live-parity.yml`

## M3 continuity gate

Canonical M3 continuity entrypoint:

```bash
npm run m3:continuity:ci
```

This gate adds the upstream Agroasys settlement-handoff contract tests to the
existing Cotsel + Cotsel-Dash live parity flow so the application boundary is
checked across all three repos before M3 closure.

Expected report fields:

- `summary.wholeProfileHealth`
- `summary.dashboardParityGate`
- `summary.dashLiveSuite`
- `summary.overallLiveParityGate`
- `blockingFailure`
- per-step statuses for env validation, local-dev bring-up, escrow deploy, session mint, parity gate, Dash repo prepare, and live suite execution

## References

- `docs/runbooks/dashboard-gateway-operations.md`
- `docs/runbooks/docker-profiles.md`
- `docs/docker-services.md`

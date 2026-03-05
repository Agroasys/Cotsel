# **Agroasys: A commercial trade settlement protocol**

_**The trustless settlement engine for cross-border commodities trade.**_

The Agroasys Web3 Layer is a modular, non-custodial settlement infrastructure built on Polkadot AssetHub. It is designed to replace traditional Letters of Credit (LC) with cryptographically secured, two-stage smart contract escrows.

While built as the settlement engine for the Agroasys Platform, this protocol is open-source and agnostic, allowing any B2B marketplace to integrate trustless stablecoin settlement with Ricardian legal enforceability.

> Founder note: Optimize for deterministic operations and auditability. If a step matters in production, it should be scriptable, tested, and documented in a runbook.

## Architecture

This repository is the settlement layer in the Agroasys platform. It operates alongside off-chain systems while serving as the on-chain source of truth for settlement state.

![web3layer](https://github.com/user-attachments/assets/c2677f8f-b430-42f6-a267-285683da74df)

- `contracts`: escrow state machine and settlement logic.
- `oracle`: validated real-world event triggers into on-chain actions.
- `indexer`: indexed chain events for query and operational visibility.
- `ricardian`: contract-hash evidence workflow linking legal agreement to settlement lifecycle.

## What This Repo Contains

- `contracts`: smart contracts, deployment modules, contract tests, and Foundry fuzzing assets.
- `oracle`: event-driven settlement trigger service.
- `indexer`: chain indexing and query pipeline.
- `sdk`: TypeScript SDK used by integrating services and clients.
- `auth` + `shared-auth`: authentication service and shared auth package.
- `reconciliation`: settlement reconciliation workflows.
- `notifications`: delivery and notification workflows.
- `ricardian`: Ricardian evidence and proof workflows.
- `treasury`: treasury operations and settlement support.
- `scripts`: CI guards, release checks, and operational tooling.
- `docs/runbooks`: operational, governance, and release runbooks.

## Local Setup (Node 20)

```bash
nvm use
# expected: Node.js v20.x
npm ci
npm run lint
npm run security:deps
```

Contracts local runs require a local dev key in `HARDHAT_VAR_PRIVATE_KEY`.
Use a throwaway local-only key and never use a funded or production private key.

## Common Commands

```bash
# Contracts
npm run -w contracts compile
npm run -w contracts compile:polkavm
npm run -w contracts test

# Service quality gates (examples)
npm run -w sdk lint && npm run -w sdk test && npm run -w sdk build
npm run -w oracle lint && npm run -w oracle test && npm run -w oracle build

# Runtime profiles
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev

scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
scripts/staging-e2e-real-gate.sh
```

## CI and Release Gate

Branch protection should require:

- `ci/contracts`
- `ci/sdk`
- `ci/oracle`
- `ci/indexer`
- `ci/notifications`
- `ci/reconciliation`
- `ci/ricardian`
- `ci/treasury`
- `ci/release-gate`

To force full matrix jobs on a PR, add label `release-gate-full`.

## Runbooks

Core operations:

- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/docker-profiles.md`
- `docs/runbooks/staging-e2e-release-gate.md`
- `docs/runbooks/staging-e2e-real-release-gate.md`
- `docs/runbooks/monitoring-alerting-baseline.md`
- `docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md`

Protocol and service operations:

- `docs/runbooks/reconciliation.md`
- `docs/runbooks/oracle-redrive.md`
- `docs/runbooks/notifications.md`
- `docs/runbooks/ricardian-hash-repro.md`
- `docs/runbooks/polkavm-deploy-verification.md`
- `docs/runbooks/asset-conversion-fee-validation.md`
- `docs/runbooks/hybrid-split-walkthrough.md`
- `docs/runbooks/treasury-to-fiat-sop.md`
- `docs/runbooks/pull-over-push-claim-flow.md`

Program and governance:

- `docs/runbooks/github-roadmap-governance.md`
- `docs/runbooks/legal-evidence-package-template.md`
- `docs/runbooks/pilot-environment-onboarding.md`
- `docs/runbooks/non-custodial-pilot-user-guide.md`
- `docs/runbooks/pilot-kpi-report-template.md`

Community demo:

- `docs/runbooks/demo/community-demo-checklist.md`
- `docs/runbooks/demo/community-demo-script.md`

## Contributing

See `CONTRIBUTING.md` for contribution flow and PR expectations.

## Security

See `SECURITY.md` for disclosure policy.

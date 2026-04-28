# Operational Readiness Gap Closeout

Snapshot date: 2026-04-28

## Purpose

Record the current truth for material incomplete architecture rows without
pretending the repo is more complete than it is. This closeout narrows the gaps
that matter for production operations and identifies the evidence that must
exist before any row can move to `Done`.

## Embedded Wallet / Signer Sequencing

Current truth:

- Human privileged governance uses direct admin wallet signing through the
  gateway prepare/confirm path.
- Executor-backed signing remains scoped to delegated/service/system flows.
- SDK wallet compatibility tests exist for EIP-1193/Web3Auth-shaped providers.
- The architecture matrix still tracks remaining auth/session and wallet
  bootstrap sequencing issues.

What is now narrowed:

- The production-sensitive signer boundary is not blocked on a repo split.
- Privileged actions must not use buyer-facing account abstraction, paymaster,
  or sponsorship paths.
- Remaining work is the explicit issue-scoped completion of auth/session primary
  identity enforcement and post-login/action-scoped wallet bootstrap.

Still not done:

- This row should not be marked `Done` until issues `#122` and `#105` have
  linked implementation/test evidence proving the remaining sequencing.

Evidence:

- `docs/adr/adr-0411-human-governance-direct-wallet-signing.md`
- `docs/runbooks/gateway-governance-signer-custody.md`
- `sdk/tests/web3AuthSignerCompatibility.test.ts`

## Oracle Retry / Redrive / Approval Controls

Current truth:

- Oracle retry ceiling and terminal failure behavior are implemented in
  `oracle/src/core/trigger-manager.ts`.
- Retry exhaustion, terminal failure, redrive, and manual approval behavior have
  focused tests.
- The redrive runbook defines HMAC/replay requirements, stop conditions,
  decision flow, evidence collection, escalation, and manual approval mode.

What changed in this batch:

- Added explicit redrive acceptance checklist.
- Added alert thresholds that separate normal bounded retry from operational
  incidents.
- Added a runbook guard so the core redrive controls cannot be silently removed.
- Kept the architecture matrix row `In Progress` because repo-local tests and
  runbook controls are not the same as live operator redrive evidence.

Remaining gap:

- Live incident evidence and issue closeout still need to be linked before the
  architecture matrix should be moved to `Done`.

Evidence:

- `oracle/src/core/trigger-manager.ts`
- `oracle/tests/trigger-manager.retry-state.test.ts`
- `oracle/tests/trigger-manager.approval.test.ts`
- `docs/runbooks/oracle-redrive.md`
- `scripts/tests/oracle-redrive-runbook-guard.sh`

## Infrastructure Controls

Current truth:

- CI/release workflow files exist for DCO, roadmap policy, release gates, and
  dashboard parity.
- Operational runbooks exist for Docker profiles, runtime truth, monitoring, and
  production readiness.
- The current matrix row remains `In Progress` because startup reliability,
  ownership, shared-package boundaries, and production evidence discipline are
  being completed as separate hardening batches.

What is now narrowed:

- Infrastructure controls are not a monorepo-restructure problem.
- The remaining work is concrete: local startup preflight, shared package
  boundary guardrails, ownership map, and production-sensitive evidence index.

Still not done:

- This row should stay `In Progress` until the new hardening checks are adopted
  into the normal release/review process and dependency major-upgrade backlog
  issue `#125` is closed or explicitly deferred.

Evidence:

- `.github/workflows/`
- `docs/runbooks/docker-profiles.md`
- `docs/runbooks/monitoring-alerting-baseline.md`
- `docs/runbooks/production-readiness-checklist.md`
- `docs/owners.md`
- `docs/runbooks/production-sensitive-action-evidence.md`
- `scripts/shared-package-boundary-guard.mjs`
- `scripts/docker-services.sh`

## Non-Goals

- No fake matrix completion.
- No broad infrastructure redesign.
- No new workflow engine for oracle retry/redrive.
- No reopening settled governance signing architecture without current repo
  evidence.

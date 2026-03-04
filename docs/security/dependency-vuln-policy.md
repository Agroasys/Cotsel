# Dependency Vulnerability Policy (Baseline)

## Purpose
Define short-term dependency vulnerability posture and remediation workflow without forcing unstable upgrades.

## Current Baseline
- Target: no **Critical** or **High** vulnerabilities in the monorepo dependency tree.
- Moderate/Low findings are tracked and remediated in targeted, low-risk changes.
- `npm ls --all` must remain healthy (no dependency graph breakage).

## Remediation Rules
1. Prefer patch/minor upgrades with small lockfile churn.
2. Use overrides only when necessary, with explicit rationale in PR description.
3. Do not use `npm audit fix --force` in routine remediation.
4. Avoid major toolchain/framework migrations as part of vulnerability triage.
5. When a fix requires major upgrades, open a tracked issue and schedule it to a milestone.

## Visibility Command
Run:

```bash
npm run security:deps
```

This command is **non-enforcing** and reports:
- `npm audit --omit=dev --json` summary
- `npm audit --json` summary
- `npm ls --all` exit status

## Override Lifecycle
- Every override should include:
  - why it exists
  - first PR introducing it
  - removal condition (upstream fix version or migration milestone)
- Review overrides during dependency maintenance and remove when no longer required.

## Hardhat Major Deferral Policy (Issue #192)
### Deferral Rationale
- Scope is limited to the Hardhat major-upgrade chain where the current plugin ecosystem is incompatible with Hardhat 3.
- Deferral avoids unstable migrations that can break CI/runtime behavior and obscure vulnerability triage outcomes.
- Current evidence basis:
  - PR #191 merged low-risk updates separately.
  - PR #193 merged major-version deferral in Dependabot for the blocked chain.
  - PR #190 was closed after reproducing migration failures under the current dependency constraints.

### What Is Deferred
- Dependabot `semver-major` updates for the Hardhat chain only:
  - `hardhat`
  - `@parity/hardhat-polkadot`
  - `@parity/hardhat-polkadot-resolc`
  - `@nomicfoundation/hardhat-*` packages used in this repo
  - `@typechain/hardhat`
  - `hardhat-gas-reporter`
  - `solidity-coverage`

### Revisit Triggers
- Time-based trigger: reassess monthly during dependency maintenance cadence.
- Technical trigger: revisit immediately when plugin compatibility for Hardhat 3 is confirmed in upstream releases/changelogs.
- Event trigger: revisit when CI or Dependabot reports indicate the deferral chain no longer blocks migration.

### Cadence and Ownership
- Owner: roadmap-maintainers.
- Cadence: monthly dependency governance review and on-demand review when technical triggers fire.
- Review record: each review must update the linked issue/PR notes with keep/deprecate decision and evidence.

### Evidence Required to Lift Deferral
- Compatibility evidence for all required plugins/tooling against Hardhat 3.
- A dedicated migration PR with:
  - full workspace checks passing (`lint`, `typecheck`, `test`, `build` where present),
  - lockfile impact summary and rollback plan,
  - no use of `npm audit fix --force`.
- CI parity evidence showing no regression in contract/tooling workflows after migration.

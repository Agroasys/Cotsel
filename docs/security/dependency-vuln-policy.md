# Dependency Vulnerability Policy (Baseline)

## Purpose

Define short-term dependency vulnerability posture and remediation workflow without forcing unstable upgrades.

## Current Baseline

- Release-blocking target: no vulnerability findings at any severity in the
  production dependency tree.
- Development-toolchain findings require a patched installed artifact or evidence that the affected feature is absent.
- `pnpm list --depth Infinity` must remain healthy (no dependency graph breakage).

## Remediation Rules

1. Prefer patch/minor upgrades with small lockfile churn.
2. Use overrides only when necessary, with explicit rationale in PR description.
3. Do not use forced audit remediation in routine changes.
4. Avoid major toolchain/framework migrations as part of vulnerability triage.
5. When a fix requires major upgrades, open a tracked issue and schedule it to a milestone.

## Visibility Command

Run:

```bash
pnpm run security:deps
```

This command is **non-enforcing** and reports:

- `pnpm audit --prod --json` summary
- `pnpm audit --json` summary
- `pnpm list --depth Infinity` exit status

## Release-Blocking Gate

Run:

```bash
pnpm run security:deps:gate
```

This command is enforcing. It fails when production dependency audit output
contains any advisory, when an unapproved development advisory exists, or when
`pnpm list --depth Infinity` reports an invalid dependency graph. The release gate runs this command in
`.github/workflows/release-gate.yml` under `ci/dependency-security`.

Do not bypass this gate by masking advisories, forcing incompatible overrides,
or pinning around a vulnerable package without a documented compatibility and
reachability assessment. If a production advisory cannot be fixed immediately,
the exception must be time-bound, owned, linked to the affected package path,
and approved as release risk.

## Override Lifecycle

- Every override should include:
  - why it exists
  - first PR introducing it
  - removal condition (upstream fix version or migration milestone)
- Review overrides during dependency maintenance and remove when no longer required.

## October 2026 Advisory Disposition

[PR #865](https://github.com/Agroasys/Cotsel/pull/865) addresses the advisories that
blocked the `main` release gate on 6 October 2026. The production audit must
remain clear at every release candidate head.

- The `@graphql-tools/utils@<=12.0.0` override selects patched version 12.0.1.
  Retire it when Subsquid's GraphQL packages select a patched version directly.
  The compatibility check merges and queries two executable schemas through
  Subsquid's installed GraphQL server package.
- The `proxy-addr@<2.0.8` override selects patched version 2.0.8. Retire it when
  Express selects that version directly.
- The `stream-json@1.9.1` package patch preserves the legacy API used by Jayson
  and creates an own data property for `__proto__`. Retire it after the Web3Auth
  chain moves to a compatible patched version. The compatibility check verifies
  normal JSON-RPC parsing, the depth limit, and both assembler paths.

## November 2026 Installed-Artifact Remediation

[PR #903](https://github.com/Agroasys/Cotsel/pull/903) removes the expired development exceptions. It does not extend their expiry dates.

Cotsel security maintainers own these patches and their removal:

| Package                               | Resolution                                                                                                                                            | Removal condition                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `elliptic@6.6.1`                      | Preserve generated nonce octet width during RFC 6979 truncation. Independent P-521 and secp256k1 vectors verify deterministic signatures.             | Hardhat verification dependencies select a compatible fixed implementation. |
| `deepmerge@4.3.1`                     | Exclude `__proto__` during source and target copying, including null-prototype objects.                                                               | Jest selects a compatible fixed release.                                    |
| `minimatch@9.0.9`, `10.2.5`, `10.2.6` | Backport upstream expansion and quadratic-preprocessing bounds from commit `77a0f5c`.                                                                 | Consumers select a compatible fixed release.                                |
| `minimatch@3.1.5`, `5.1.9`            | Verify the affected optimization preprocessor is absent in installed modules.                                                                         | Remove legacy consumers.                                                    |
| `glob@10.5.0`, `13.0.6`               | Return immediately from aborted walker callbacks. Route version 13 exports through patched published modules, avoiding stale bundled implementations. | Consumers select a compatible fixed release.                                |
| `brace-expansion@5.0.12`              | Preserve callable CommonJS and default ESM imports for legacy minimatch consumers.                                                                    | Remove legacy import requirements.                                          |
| `stream-json@1.9.1`                   | Retain existing depth and prototype patches. Verify affected JSONC entry points are absent and strict parsing rejects comments.                       | Web3Auth selects a compatible fixed implementation.                         |

The helper-specific `ethereumjs-util` alias uses `@ethereumjs/util@9.1.0` for its two address-validation functions. Regression checks cover valid, malformed, and invalid-checksum addresses.

The gate resolves the active installed graph. It does not inspect unused packages retained in pnpm's virtual store.

Each resolution matches the advisory ID, package, severity, exact versions, and upstream fixed-version range. Installed-artifact regression failure blocks release.

Unknown advisories, malformed reports, failed audit commands, invalid dependency trees, and every production finding block release. The gate has no development risk exceptions.

Run `pnpm run security:deps:gate` after each dependency change. This command also tests the gate's rejection paths.

The upstream advisory scanner still reports patched package versions. A green repository gate does not replace release-candidate scans or independent acceptance.

Patch references:

- [RFC 6979 nonce generation](https://www.rfc-editor.org/rfc/rfc6979.html#section-3.2)
- [Elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84)
- [Deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
- [Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
- [JSONC advisory](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x)

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

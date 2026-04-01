# Polkadot Retirement Checklist

## Purpose and scope
Close the M5-owned Polkadot retirement items against the stale-artifact register in issue `#356`.

This checklist covers:
- active CI and release-gate retirement
- active API contract retirement
- historical runbook and governance boundary hardening
- explicit disposition for the M5-owned residue retained for audit

This checklist does not cover:
- deletion of historical evidence that still has audit value
- cross-repo migrations that are not represented in the active Cotsel repo surfaces

## Binding register
- Canonical stale-artifact register: issue `#356`
- M5 epic: issue `#345`
- H5 closure issue: issue `#396`

## Retirement decisions
Each M5-owned item must be in one of these states:
- removed from active CI or API path
- archived in place with explicit historical framing
- retained as compatibility-only with explicit non-canonical status

## M5-owned residue closure table
| Register item | Path | Final disposition | Validation evidence |
| --- | --- | --- | --- |
| Historical A/B/C governance checks | `.github/workflows/release-gate.yml` | Removed from active release gate | Active release gate no longer references historical A/B/C jobs |
| Historical A/B/C governance maintenance | `.github/workflows/historical-archive-maintenance.yml`, `.github/workflows/roadmap-weighted-progress-sync.yml` | Manual archive-only maintenance | Historical workflows are `workflow_dispatch` only |
| Historical governance helpers | `scripts/architecture-roadmap-consistency-check.mjs`, `scripts/arch-roadmap-sync.mjs` | Historical maintenance only | Referenced only from archive maintenance and governance docs |
| Historical asset fee validation | `docs/runbooks/asset-conversion-fee-validation.md`, `scripts/tests/asset-fee-path-gate.test.sh` | Archived in place and removed from active release gate | Active release gate no longer runs asset fee-path checks |
| Historical PolkaVM deploy verification | `docs/runbooks/polkavm-deploy-verification.md`, `scripts/tests/polkavm-deploy-verify-smoke.test.mjs` | Archived in place and removed from active release gate | Active release gate no longer runs PolkaVM deploy verification |
| Historical A/B/C matrix | `docs/runbooks/architecture-coverage-matrix.md` | Historical-only with explicit non-authoritative status | Matrix no longer points operators at active weekly maintenance for Base truth |
| Active settlement ingress `extrinsicHash` field | `docs/api/cotsel-dashboard-gateway.openapi.yml`, `gateway/src/routes/settlement.ts` | Retired from active public contract | OpenAPI no longer exposes `extrinsicHash`; route rejects the field |

## Active-surface retirement checks
Complete all of the following before closing `#396`:
1. `ci/release-gate` does not require or summarize historical Polkadot jobs.
2. Active API docs do not present `extrinsicHash` as a first-class request field.
3. Active operator runbooks do not instruct launch or rollback operators to use Polkadot-era runtime paths.
4. Historical docs that remain are immediately identifiable as historical-only.
5. The active Base mainnet launch docs explicitly treat historical Polkadot artifacts as audit-only during rollback.

## Validation procedure
Run targeted grep against active repo surfaces:

```bash
rg -n "Polkadot|PolkaVM|AssetHub|Paseo|extrinsicHash|extrinsicIndex" \
  .github/workflows \
  docs/runbooks \
  docs/api \
  gateway/src/routes
```

Review each remaining match and confirm it is one of:
- historical-only
- archive-only
- internal compatibility-only and not part of the active public contract

## Closure rule
Issue `#396` may close only when:
- every M5-owned `#356` item above has an explicit final disposition
- active release paths are Base-only
- active API and runbook surfaces no longer keep dual-truth ambiguity alive

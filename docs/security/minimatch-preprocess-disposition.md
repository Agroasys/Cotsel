# Minimatch preprocessing advisory disposition

Audience: dependency and Security reviewers. Scope: GHSA-g3hv-75wg-m249 for the exact installed artifacts listed below.

The [upstream advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) lists versions below 11.0.1. Its described defect concerns pattern multiplication and pairwise deduplication in the level-two preprocessing algorithm. The [upstream repair](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8) bounds those operations.

| Installed version     | Repository disposition                                                                                                                                        | Verification                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.9, 10.2.5, 10.2.6 | Backport the upstream repair in CommonJS and ESM distributions.                                                                                               | Check resolved patched consumers, capped pattern multiplication, large-set deduplication behavior and ordinary matching.                                                        |
| 3.1.5, 5.1.9          | The inspected sources do not implement the reported preprocessing algorithm. This is a repository applicability assessment, not an upstream range correction. | Verify exact source hashes, absence of the two preprocessing methods and optimization option, ordinary matching, and a repeated globstar/parent pattern without multiplication. |

The legacy `minimatch.js` SHA-256 values are:

- 3.1.5: `746849f267c4868a53729225bd85c7dccd387712136fb305fcc0a3eadd4a3d9d`
- 5.1.9: `1339bca8b70e33847860daa8fc3ccfa62487e143670da01a3b718d40d5fd424f`

The release gate accepts this disposition only for the exact advisory identifier, package, severity, affected range, patched range and listed versions. It also pins the audit overview SHA-256 to `864649cfe8b481d0f1de3513fe2ce8d7be9dc660d35c7d1497e3275d29616c75`. Changed advisory content requires reassessment. Compatibility verification must pass; a changed legacy source or missing backport fails the gate.

This disposition addresses the described algorithm only. It does not assert that older minimatch versions are free of other defects. New advisories remain unclassified and fail the gate. Production dependency findings continue to fail independently. Existing time-limited exceptions retain their expiry dates.

Run `pnpm run security:deps:compat` and `pnpm run security:deps:gate` after a clean frozen install. Independent review of the backports and applicability assessment is required before merge. No candidate acceptance, residual-risk waiver or staging authorization is recorded here.

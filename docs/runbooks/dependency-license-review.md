# Dependency License Review Runbook

## Purpose

Generate a deterministic snapshot of third-party production dependency licenses for review by legal/compliance.

## Command

From repository root:

```bash
pnpm run licenses:report
```

The report is generated from `pnpm list --recursive --depth Infinity --json --long --prod`.

## Output Artifacts

The command writes two files:

- `reports/licenses/third-party-licenses.json`
- `reports/licenses/third-party-licenses-summary.txt`

## How to Review

1. Confirm the report generated from a clean install (`pnpm install --frozen-lockfile`) on the branch under review.
2. Review `third-party-licenses-summary.txt` for any newly introduced license families.
3. Use `third-party-licenses.json` for package-level attribution details.
4. Escalate unknown or policy-restricted licenses to legal/compliance before release.

## Notes

- CI requires a non-empty inventory covering every workspace. Missing workspaces or malformed output fail the aggregate.
- CI retains license reports with the source commit. Unknown licenses require an independent disposition before promotion.
- Inventory success is not legal acceptance. Attach the reviewed report and decision to the candidate evidence index.
- Keep generated files as review artifacts; do not treat this as a policy allow/deny engine.

# Dependency License Review Runbook

## Purpose

Generate a deterministic snapshot of third-party production dependency licenses for review by legal/compliance.

## Command

From repository root:

```bash
npm run licenses:report
```

The report is generated from `npm ls --all --json --long --omit=dev`.

## Output Artifacts

The command writes two files:

- `reports/licenses/third-party-licenses.json`
- `reports/licenses/third-party-licenses-summary.txt`

## How to Review

1. Confirm the report generated from a clean install (`npm ci`) on the branch under review.
2. Review `third-party-licenses-summary.txt` for any newly introduced license families.
3. Use `third-party-licenses.json` for package-level attribution details.
4. Escalate unknown or policy-restricted licenses to legal/compliance before release.

## Notes

- This runbook is advisory and does not fail CI by default.
- Keep generated files as review artifacts; do not treat this as a policy allow/deny engine.

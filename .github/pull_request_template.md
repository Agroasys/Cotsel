## Summary

- What changed:
- Why:

## Roadmap Governance

- [ ] Linked to a repo Milestone
- [ ] Added to `Cotsel Roadmap` Project v2
- [ ] Mapped to correct roadmap area/status/priority in Project fields

## Validation

- [ ] Lint passed for changed workspaces
- [ ] Tests passed for changed workspaces
- [ ] Build passed for changed workspaces
- [ ] CI checks are green on this PR
- [ ] Docs updated for behavior/config changes
- [ ] I have signed off all commits (DCO)

## Safety checklist

- [ ] No ABI-breaking changes unless explicitly approved
- [ ] No escrow economics/payout-path changes
- [ ] No token flow changes
- [ ] No key material or secrets added to logs
- [ ] Rollback path documented

## Runtime checks (if infra touched)

- [ ] `scripts/cotsel.sh up`
- [ ] `scripts/cotsel.sh health`
- [ ] `scripts/cotsel.sh up --gate` (full validated deploy, when applicable)

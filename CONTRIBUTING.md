# Contributing to Cotsel

Thanks for contributing. This repository is production-bound Web3 settlement infrastructure.
Changes can impact financial safety, on-chain correctness, and operational reliability.
Contributions are welcome, but quality and safety bars are strict.

By contributing, you agree to license your work under [Apache-2.0](LICENSE).

## Security Reporting
Do **not** report vulnerabilities in public issues.

Report security issues privately to: `security@agroasys.com`

Include:
- impacted module(s)
- severity and exploit/failure scenario
- minimal reproducible steps
- proposed remediation (if available)

## Repository Scope
This monorepo currently contains:
- `contracts`: escrow smart contracts and tests
- `sdk`: shared TypeScript SDK
- `oracle`: oracle service
- `indexer`: indexing service
- `reconciliation`: reconciliation worker
- `notifications`: shared notifications library (no standalone runtime)
- `ricardian`: deterministic hash service
- `treasury`: treasury ledger service

## Hard Safety Guardrails
Unless explicitly requested by maintainers:
- do not change escrow payout economics
- do not change token-flow paths
- do not change contract ABI/event signatures
- do not merge undocumented behavior changes
- do not log secrets, private keys, signatures, or raw auth material

If your change touches any guarded area, document impact and rollback plan in the PR.

## Prerequisites
- Node.js 20.x
- npm 10+
- Docker + Docker Compose (for infra/runtime checks)

## Setup
```bash
git clone https://github.com/Agroasys/Cotsel.git
cd Cotsel
npm ci
```

For local contracts checks, set test private key variables as needed by Hardhat:
```bash
export HARDHAT_VAR_PRIVATE_KEY=0x0123456789012345678901234567890123456789012345678901234567890123
export HARDHAT_VAR_PRIVATE_KEY2=0x1111111111111111111111111111111111111111111111111111111111111111
```

## Branching and Commit Style
- Branch from `main`
- Keep one concern per branch/PR
- Keep diffs small and reversible
- Use Conventional Commits: `<type>(<scope>): <subject>`

Examples:
- `fix(security): reject invalid auth nonce format`
- `docs(runbook): add reconciliation rollback procedure`
- `ci(matrix): add workspace release gate report`

## Development Workflow
1. Create branch
```bash
git checkout -b <type>/<short-topic>
```
2. Implement minimal scoped changes
3. Add or update tests for changed behavior
4. Run validation commands for touched workspaces
5. Open PR with clear summary, risk notes, and rollback steps

## Validation Requirements
Run checks for each changed workspace.

### Common
```bash
npm run lint
```

### Workspace checks (examples)
```bash
npm run -w contracts lint
npm run -w contracts compile
npm run -w contracts test

npm run -w sdk lint
npm run -w sdk test
npm run -w sdk build

npm run -w oracle lint
npm run -w oracle test
npm run -w oracle build

npm run -w indexer lint
npm run -w indexer build

npm run -w reconciliation lint
npm run -w reconciliation test
npm run -w reconciliation build

npm run -w ricardian lint
npm run -w ricardian test
npm run -w ricardian build

npm run -w treasury lint
npm run -w treasury test
npm run -w treasury build
```

Use `--if-present` where needed if a workspace does not define a script in your branch context.

## Docker/Runtime Validation (When Infra Is Touched)
Use profile-aware scripts:
```bash
scripts/docker-services.sh up local-dev
scripts/docker-services.sh health local-dev

scripts/docker-services.sh up staging-e2e
scripts/docker-services.sh health staging-e2e
scripts/staging-e2e-gate.sh
```

Use service DNS inside compose networking (never `localhost` for inter-container calls).

## Testing Expectations
- add deterministic tests for any logic change
- avoid flaky time/race assumptions
- for replay/auth/rate-limit logic, include negative-path tests
- preserve existing passing suites; do not silence failures

## Documentation Expectations
Update docs when behavior or operations change:
- `README.md` for user-facing usage changes
- service `README.md` for endpoint/config changes
- `docs/runbooks/*` for operational procedures

## Pull Request Requirements
Use `.github/pull_request_template.md` and complete all relevant checks.

Every PR should include:
- what changed and why
- validation commands run and results
- safety impact statement
- rollback steps

If applicable, explicitly confirm:
- no escrow contract ABI changes
- no escrow economics/payout-path changes
- no token-flow changes

## Code Review Criteria
Reviewers will prioritize:
- correctness and security
- backward compatibility
- deterministic tests
- operational clarity and runbook quality
- minimal, focused diffs

## Issue Reporting
Use GitHub Issues:
- https://github.com/Agroasys/Cotsel/issues

Include:
- affected module
- reproducible steps
- expected vs actual behavior
- environment details
- logs/error snippets (sanitized)

## DCO Sign-off (Required)
All commits in pull requests must include `Signed-off-by`.

Quick command for new commits:
```bash
git commit -s -m "fix(scope): summary"
```

Fix a single existing commit:
```bash
git commit --amend -s --no-edit
```

Fix sign-off across multiple commits:
```bash
git rebase --signoff origin/main
```

If manual per-commit edits are needed:
```bash
git rebase -i origin/main
# mark commits as edit
# for each commit:
git commit --amend -s --no-edit
git rebase --continue
```

See `.github/DCO.md` for the full policy and workflow details

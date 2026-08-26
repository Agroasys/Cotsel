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
- `treasury`: settlement-evidence and payout-eligibility service

## Hard Safety Guardrails

Unless explicitly requested by maintainers:

- do not change escrow payout economics
- do not change token-flow paths
- do not change contract ABI/event signatures
- do not merge undocumented behavior changes
- do not log secrets, private keys, signatures, or raw auth material

If your change touches any guarded area, document impact and rollback plan in the PR.

## Prerequisites

- Node.js 22.23.2
- pnpm 10.34.4 through Corepack
- Docker + Docker Compose (for infra/runtime checks)

## Setup

```bash
git clone https://github.com/Agroasys/Cotsel.git
cd Cotsel
corepack enable
corepack prepare pnpm@10.34.4 --activate
pnpm install --frozen-lockfile
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
pnpm run lint
```

### Workspace checks (examples)

```bash
pnpm --filter ./contracts run lint
pnpm --filter ./contracts run compile
pnpm --filter ./contracts run test

pnpm --filter ./sdk run lint
pnpm --filter ./sdk run test
pnpm --filter ./sdk run build

pnpm --filter ./oracle run lint
pnpm --filter ./oracle run test
pnpm --filter ./oracle run build

pnpm --filter ./indexer run lint
pnpm --filter ./indexer run build

pnpm --filter ./reconciliation run lint
pnpm --filter ./reconciliation run test
pnpm --filter ./reconciliation run build

pnpm --filter ./ricardian run lint
pnpm --filter ./ricardian run test
pnpm --filter ./ricardian run build

pnpm --filter ./treasury run lint
pnpm --filter ./treasury run test
pnpm --filter ./treasury run build
```

Use `--if-present` where needed if a workspace does not define a script in your branch context.

## Docker/Runtime Validation (When Infra Is Touched)

There is one compose profile (`runtime`) and one env file (`.env.runtime`):

```bash
scripts/cotsel.sh up
scripts/cotsel.sh health

# Full validated deploy + release gate
scripts/cotsel.sh up --gate
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

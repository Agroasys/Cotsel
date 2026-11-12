# Five-issue Cotsel closeout

Audience: Cotsel engineers, Release Owner, and independent acceptance reviewers.
Scope: #650, #669, #653, #683, and #676 on one Base Sepolia staging candidate.
Outcome: reproducible implementation evidence and an explicit decision for each issue.

Local checks do not establish deployed behavior or acceptance. Keep the five issues open until their required evidence is accepted.

## Prepare the test environment

1. Use an isolated checkout of the selected source commit.
2. Use the Node version in `.nvmrc` and the pnpm version in `package.json`.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Verify Docker can start disposable PostgreSQL 16 containers.
5. Provide separate loopback PostgreSQL databases for enabled Gateway and Indexer tests.
6. Record the commands, timestamps, source commit, and report hashes.

Auth lineage and cutover tests require Docker. They skip when Docker is unavailable.
Require every mandatory test to execute. Do not infer execution from a successful suite summary.

## Run the owning service checks

Run these commands from the Cotsel root. Set database URLs to disposable loopback databases only.

```sh
pnpm --filter ./auth test --json --outputFile=/absolute/evidence/auth.json
GATEWAY_TEST_USE_LOCAL_POSTGRES=true pnpm --filter ./gateway test --json --outputFile=/absolute/evidence/gateway.json
INDEXER_MIGRATION_TEST_DATABASE_URL="$INDEXER_TEST_ADMIN_URL" pnpm --filter ./indexer test
RUN_ORACLE_DISPATCH_POSTGRES=true ORACLE_DISPATCH_POSTGRES_ADMIN_URL="$ORACLE_TEST_ADMIN_URL" pnpm --filter ./oracle test --json --outputFile=/absolute/evidence/oracle.json
TREASURY_POSTGRES_TESTS=true pnpm --filter ./treasury test --json --outputFile=/absolute/evidence/treasury.json
pnpm --filter ./ricardian test --json --outputFile=/absolute/evidence/ricardian.json
pnpm --filter ./relayer test
pnpm --filter @agroasys/shared-auth test
pnpm --filter @agroasys/shared-http test
pnpm --filter @agroasys/shared-edge test
pnpm --filter ./reconciliation test
bash scripts/tests/validate-env-runtime-service-auth.test.sh
bash scripts/tests/validate-env-production-auth.test.sh
node --test scripts/tests/strict-runtime-env.test.mjs scripts/tests/staging-production-config.test.mjs
```

The Oracle manual suite contains disabled deployed-action cases. List them separately; local checks cannot accept them.
Do not enable financial-action tests against an unapproved shared environment.

## Verify the required outcomes

| Issue | Required local proof                                                                                                               | Required deployed proof                                                                   | Acceptance owner                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| #650  | Exact HTTP, PostgreSQL, replay, and callback amounts; invalid stored-value containment and recovery                                | Candidate-bound stored-value, callback, and independent financial reconciliation          | Finance and Data reviewers         |
| #669  | Strict environment parsing, deterministic redacted digest, integer session settings, and non-disableable production authentication | Running configuration identity and service-to-service denial probes                       | Security and Release reviewers     |
| #653  | Startup denial, checkpoint identity, failed RPC, quarantine, distinct liveness/readiness, and recovery                             | Pinned contract identity and deployed failure/recovery probes                             | Data and Platform reviewers        |
| #683  | Safe HTTP/parser/provider/database errors, correlation, sanitized telemetry, and no authenticated handler after failure            | Equivalent injections through the deployed ingress and service paths                      | Security reviewer                  |
| #676  | Single-successor refresh, insert-failure rollback, lock-wait expiry, verifier rejection, lifetime bounds, and cutover recovery     | Hosted exchange, disabled users, role drift, revocation, expiry, and compatible consumers | Security and Integration reviewers |

Auth, Gateway, Oracle, Treasury, Ricardian, Relayer, Indexer, and Reconciliation validate deployment profiles before startup.
`COTSEL_ENVIRONMENT` accepts `local`, `staging`, or `production`, with case and surrounding whitespace normalized.
Unsupported profiles fail startup. Staging and production profiles require `NODE_ENV=production`, including direct launches.
An unset deployment profile retains local behavior. Auth still requires an explicit environment under `NODE_ENV=production`. Auth numeric settings reject fractions, exponents, suffixes, and unsafe integers.

## Complete validation and review

1. Run repository lint, typecheck, formatting, documentation, boundary, source-size, dependency, and release-contract checks.
2. Run M3 with explicit checkout paths matching the cross-repository manifest.
3. Review both repository standards and issue requirements.
4. Fix every demonstrated defect within this scope.
5. Revalidate changes after formatting, hooks, and review corrections.
6. Record remaining unavailable scenarios without treating them as passed.

## Bind evidence and obtain acceptance

1. Verify the current platform, contract, traffic path, and archive custody through their owning controls.
2. Publish final-main artifacts only through the authorized release process.
3. Freeze the complete candidate manifest, including sibling sources, migrations, configuration, provider modes, and rollback identity.
4. Run the deployed scenarios with synthetic participants and no real commercial value.
5. Retain redacted evidence through the accepted custody path.
6. Route contributor evidence to its primary acceptance owner.
7. Obtain each issue's named review decision.
8. Validate identity binding and accepted primary controls.

```sh
node scripts/check-release-evidence-binding.mjs \
  --manifest /absolute/evidence/candidate-manifest.json \
  --index /absolute/evidence/evidence-index.json \
  --require-controls I-05,H-09,H-28,H-30,I-06,H-20,H-21,I-07,GJ-01
```

The validator checks declared acceptance. Reviewers must inspect the actual evidence and contributor obligations before recording their decisions.
Do not accept evidence produced by the same person. Preserve the release-authority profile.

## Rollback and invalidation

Reject inconsistent deployment profiles and unavailable authentication dependencies before protected actions execute.
Retain stored monetary evidence and contain corrupt records; do not round or overwrite them to clear a failure.
Retain the accepted checkpoint identity during Indexer recovery. Do not rewind without reviewed chain evidence.
Use the reviewed Auth cutover procedure; an old image cannot read the hashed-session schema without its documented recovery steps.

A material source, artifact, migration, configuration, provider, or contract change invalidates affected evidence.
Create a new candidate and rerun affected checks. Reuse evidence only through the existing reviewed equivalence mechanism.

# Repair the identified staging baselines

Gateway and Oracle staging were created before their immutable baseline manifests.
The migration runner correctly refuses to adopt these schemas. This repair preserves
existing rows and does not change the manifests or write migration ledger entries.

`shared-db/repair-staging-baseline.js` accepts only the identified Mumbai staging
host, service database and migration user. It checks the observed fingerprint,
requires an absent migration ledger, verifies the baseline file checksum, applies
its schema transactionally, and checks the resulting baseline fingerprint before
committing. An unexpected schema or failed constraint validation rolls back.

Before execution, retain an encrypted snapshot and stop the affected service and
its migration tasks. Register a dedicated task revision from the candidate's
existing migration task with command `node shared-db/repair-staging-baseline.js`.
Set `COTSEL_ENVIRONMENT=staging` and `COTSEL_STAGING_BASELINE_REPAIR=true` in that
revision. Preserve its migration-only credentials, private networking and image
digest. Run without overrides. Do not grant this task a database master credential.

Require exit code zero and the service-specific repair success marker. Then run
the normal migration task and verify its ledger and final schema. Repeat the
normal migration task to prove no pending work. Run the entitlement verifier.
A successful repair alone is not deployment acceptance.

The PostgreSQL regression tests recreate both observed schema definitions,
preserve representative rows, reject added schema drift, and reject repeated
repair. Run them with `REPAIR_TEST_DATABASE_URL` pointing to a disposable
PostgreSQL 16 instance and `pnpm --filter @agroasys/shared-db run
test:staging-repair:postgres`.

## Indexer history adoption

The indexer history has 17 unchecksummed entries through `1785000000000`. Their
source files match deployed commit `c09b792db8637416b2239102f19c7ffe6d1320e3`.
A PostgreSQL 16 replay of that prefix matches the live application schema.
`indexer/adopt-staging-history.js` checks both the exact source-manifest digest
and the schema fingerprint before recording checksums. It records the method as
`schema-replay-adoption` in a separate restricted audit schema; it does not claim
that the old deployment originally recorded those checksums.

Use a dedicated candidate migration-task revision with command
`node indexer/adopt-staging-history.js`, `COTSEL_ENVIRONMENT=staging` and
`COTSEL_STAGING_HISTORY_ADOPTION=true`. The script accepts only the identified
indexer staging coordinates and migration account. Keep the indexer and other
migration tasks stopped. Require exit zero, then run the normal indexer migration
and verify the full manifest and reader permissions.

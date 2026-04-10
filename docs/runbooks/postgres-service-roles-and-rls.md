# Postgres Service Roles And RLS

This runbook defines the production DB access model for the service-owned Cotsel
databases. It replaces the old single-role posture where services commonly ran
with broad Postgres credentials.

This is **service-level DB isolation**, not actor-aware row ownership. It narrows
database blast radius for each service, but it does not replace application-layer
authorization for buyer/admin/operator semantics.

## Scope

This model applies to the service-owned operational databases for:

- `auth`
- `gateway`
- `oracle`
- `reconciliation`
- `ricardian`
- `treasury`

It does not currently apply to the indexer database. The indexer stores derived
chain mirror data and remains outside the Phase 3 sensitive-table scope.

## Role model

Each service gets two distinct Postgres login roles:

- runtime role
- migration role

Runtime roles are least-privilege application users. They are expected to read
and write only the tables their service owns, and only when the connection is
tagged with the correct service session settings.

Migration roles are used only during schema bootstrap and migrations. They are
allowed to create/alter objects in the target service database schema and grant
runtime access to the corresponding runtime role.

The canonical environment variables are:

- `DB_USER`
- `DB_PASSWORD`
- `DB_MIGRATION_USER`
- `DB_MIGRATION_PASSWORD`

In the compose examples, these are wired from service-specific variables such as
`AUTH_DB_RUNTIME_USER` / `AUTH_DB_MIGRATION_USER`.

## Session settings contract

Runtime and migration pools stamp every connection with Postgres session
settings through `PGOPTIONS`:

- `app.service_name`
- `app.connection_role`
- `app.runtime_db_user`

Those settings are added by `@agroasys/shared-db`.

RLS policies depend on `app.service_name`. Migration-time grants depend on
`app.runtime_db_user`.

That means the security model has two layers:

1. SQL grants determine whether the login role can touch the table at all.
2. RLS determines whether the session is tagged as the correct service.

If either is wrong, access is denied.

## Table policy intent

The current Phase 3 policies are service-isolation policies.

They are intentionally strict:

- the service that owns the table may access it
- other service roles may not
- sessions missing `app.service_name` may not
- broad public access is revoked

This is the current mapping:

- `auth`
  - `user_profiles`
  - `user_sessions`
  - `trusted_session_exchange_nonces`
- `gateway`
  - `idempotency_keys`
  - `audit_log`
  - `failed_operations`
  - `access_log_entries`
  - `role_assignments`
  - `governance_actions`
  - `compliance_decisions`
  - `oracle_progression_blocks`
  - `evidence_bundles`
  - `service_auth_nonces`
  - `settlement_handoffs`
  - `settlement_execution_events`
  - `settlement_callback_deliveries`
- `oracle`
  - `oracle_triggers`
  - `oracle_hmac_nonces`
- `reconciliation`
  - `reconcile_runs`
  - `reconcile_drifts`
  - `reconcile_run_trades`
- `ricardian`
  - `ricardian_hashes`
  - `ricardian_auth_nonces`
- `treasury`
  - `treasury_ledger_entries`
  - `payout_lifecycle_events`
  - `treasury_ingestion_state`
  - `treasury_auth_nonces`
  - `fiat_deposit_references`
  - `fiat_deposit_events`
  - `bank_payout_confirmations`

## Local and staging bootstrap

`docker-compose.services.yml` now provisions:

- service databases
- service runtime roles
- service migration roles
- `CONNECT` grants on each service database
- `USAGE` on `public` for runtime roles
- `USAGE, CREATE` on `public` for migration roles

The compose bootstrap does not make runtime roles owners of the schema.

## Production rollout steps

1. Create one runtime role and one migration role per service.
2. Grant each pair access only to its own database.
3. Grant `USAGE` on the target schema to the runtime role.
4. Grant `USAGE, CREATE` on the target schema to the migration role.
5. Run schema migrations with the migration role while setting
   `app.runtime_db_user` to the runtime role.
6. Run services with runtime credentials only.
7. Verify that cross-service reads fail and missing `app.service_name` fails.

## Validation expectations

Phase 3 is not considered complete unless all of the following are true:

- schema SQL enables and forces RLS on every sensitive table in scope
- runtime and migration credentials are separate in config
- compose/bootstrap examples provision distinct roles
- automated tests prove:
  - correct service role plus correct `app.service_name` succeeds
  - correct role plus wrong `app.service_name` fails
  - correct role plus missing `app.service_name` fails
  - unrelated role fails

The Docker-backed proof for those cases lives in
`shared-db/postgres-rls.integration.test.js`.

## What this does not solve

This model does not replace application-level authz. It narrows the blast
radius of database credentials and adds DB-backed service isolation, but route
authz and business rules still matter.

It also does not implement per-user or per-admin row ownership policies. If
actor-aware CRUD policy is needed later, that must be treated as a separate
design and migration program.

It also does not finish treasury/off-ramp backlog or indexer data governance.
Those remain separate workstreams.

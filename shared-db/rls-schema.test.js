'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Read every SQL file the service's manifest declares, in order.
 *
 * Reading only the baseline `schema.sql` would leave any table introduced by a
 * later migration unchecked, which is exactly where a missing RLS policy would
 * hide.
 */
function serviceSchemaSql(serviceName) {
  const databaseRoot = path.resolve(__dirname, '..', serviceName, 'src', 'database');
  const manifest = JSON.parse(fs.readFileSync(path.join(databaseRoot, 'migrations.json'), 'utf8'));
  return manifest.migrations
    .map((migration) => fs.readFileSync(path.join(databaseRoot, migration.file), 'utf8'))
    .join('\n');
}

const schemaExpectations = [
  {
    serviceName: 'auth',
    tables: ['user_profiles', 'user_sessions', 'trusted_session_exchange_nonces'],
  },
  {
    serviceName: 'gateway',
    tables: [
      'idempotency_keys',
      'audit_log',
      'failed_operations',
      'access_log_entries',
      'role_assignments',
      'compliance_decisions',
      'oracle_progression_blocks',
      'evidence_bundles',
      'service_auth_nonces',
      'settlement_handoffs',
      'settlement_execution_events',
      'settlement_callback_deliveries',
      'managed_signer_validation_audit',
    ],
  },
  {
    serviceName: 'treasury',
    tables: [
      'treasury_ledger_entries',
      'payout_lifecycle_events',
      'treasury_ingestion_state',
      'treasury_auth_nonces',
      'fiat_deposit_references',
      'fiat_deposit_events',
      'bank_payout_confirmations',
    ],
  },
  {
    serviceName: 'oracle',
    tables: ['oracle_triggers', 'oracle_hmac_nonces'],
  },
  {
    serviceName: 'reconciliation',
    tables: ['reconcile_runs', 'reconcile_drifts', 'reconcile_run_trades', 'reconcile_cursors'],
  },
  {
    serviceName: 'ricardian',
    tables: ['ricardian_hashes', 'ricardian_auth_nonces'],
  },
];

function assertSchemaHasRlsPolicies({ serviceName, tables }) {
  const sql = serviceSchemaSql(serviceName);

  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION current_app_service_name\(\)/);

  for (const table of tables) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`DROP POLICY IF EXISTS ${table}_service_isolation ON ${table};`));

    if (serviceName === 'ricardian' && table === 'ricardian_hashes') {
      assert.match(
        sql,
        new RegExp(
          `CREATE POLICY ${table}_service_isolation_select ON ${table}[\\s\\S]*FOR SELECT[\\s\\S]*USING \\(current_app_service_name\\(\\) = '${serviceName}'\\)`,
        ),
      );
      assert.match(
        sql,
        new RegExp(
          `CREATE POLICY ${table}_service_isolation_insert ON ${table}[\\s\\S]*FOR INSERT[\\s\\S]*WITH CHECK \\(current_app_service_name\\(\\) = '${serviceName}'\\)`,
        ),
      );
      continue;
    }

    assert.match(
      sql,
      new RegExp(
        `CREATE POLICY ${table}_service_isolation ON ${table}[\\s\\S]*current_app_service_name\\(\\) = '${serviceName}'`,
      ),
    );
  }
}

for (const expectation of schemaExpectations) {
  test(`${expectation.serviceName} schema enables forced RLS on every service-owned table`, () => {
    assertSchemaHasRlsPolicies(expectation);
  });
}

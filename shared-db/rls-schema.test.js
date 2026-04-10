'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaExpectations = [
  {
    serviceName: 'auth',
    schemaPath: path.resolve(__dirname, '../auth/src/database/schema.sql'),
    tables: [
      'user_profiles',
      'user_sessions',
      'trusted_session_exchange_nonces',
    ],
  },
  {
    serviceName: 'gateway',
    schemaPath: path.resolve(__dirname, '../gateway/src/database/schema.sql'),
    tables: [
      'idempotency_keys',
      'audit_log',
      'failed_operations',
      'access_log_entries',
      'role_assignments',
      'governance_actions',
      'compliance_decisions',
      'oracle_progression_blocks',
      'evidence_bundles',
      'service_auth_nonces',
      'settlement_handoffs',
      'settlement_execution_events',
      'settlement_callback_deliveries',
    ],
  },
  {
    serviceName: 'treasury',
    schemaPath: path.resolve(__dirname, '../treasury/src/database/schema.sql'),
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
    schemaPath: path.resolve(__dirname, '../oracle/src/database/schema.sql'),
    tables: [
      'oracle_triggers',
      'oracle_hmac_nonces',
    ],
  },
  {
    serviceName: 'reconciliation',
    schemaPath: path.resolve(__dirname, '../reconciliation/src/database/schema.sql'),
    tables: [
      'reconcile_runs',
      'reconcile_drifts',
      'reconcile_run_trades',
    ],
  },
  {
    serviceName: 'ricardian',
    schemaPath: path.resolve(__dirname, '../ricardian/src/database/schema.sql'),
    tables: [
      'ricardian_hashes',
      'ricardian_auth_nonces',
    ],
  },
];

function assertSchemaHasRlsPolicies({ serviceName, schemaPath, tables }) {
  const sql = fs.readFileSync(schemaPath, 'utf8');

  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION current_app_service_name\(\)/);

  for (const table of tables) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`DROP POLICY IF EXISTS ${table}_service_isolation ON ${table};`));
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

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { Pool } = require('pg');
const { computePublicSchemaFingerprint } = require('./schema-fingerprint');
const { runVersionedMigrations } = require('./migrate');
const { parseSettlementFundedBinding } = require('../sdk/dist/settlementFundedBinding');

const enabled = process.env.RUN_FUNDED_BINDING_POSTGRES === 'true';
test(
  'funded progression migrations preserve scope and reject legacy financial acceptance (local PostgreSQL)',
  { skip: !enabled, timeout: 60000 },
  async () => {
    const url = new URL(
      process.env.FUNDED_BINDING_POSTGRES_ADMIN_URL ||
        'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    );
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'This disposable proof must use a local database',
    );
    url.pathname = '/postgres';
    const admin = new Pool({ connectionString: url.toString() });
    const identity = `funded_binding_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE ROLE ${identity} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const binding = parseSettlementFundedBinding({
      scopeVersion: 'agroasys.funded-settlement-binding.v1',
      ownerServiceId: 'controlled-platform',
      sourceOperationId: '42',
      phase: 'initial_release_after_custody_and_documents',
      chainId: '31337',
      escrowAddress: `0x${'1'.repeat(40)}`,
      tokenAddress: `0x${'2'.repeat(40)}`,
      tradeId: '1',
      buyerAddress: `0x${'3'.repeat(40)}`,
      supplierAddress: `0x${'4'.repeat(40)}`,
      ricardianHash: `0x${'5'.repeat(64)}`,
      totalAmount: '1000',
      logisticsAmount: '100',
      platformFeesAmount: '50',
      supplierFirstTranche: '350',
      supplierSecondTranche: '500',
      supplierPayoutAmount: '350',
      treasuryAccrualAmount: '150',
      buyerRefundAmount: '0',
      fundingTransactionHash: `0x${'a'.repeat(64)}`,
      fundingBlockNumber: '100',
      fundingBlockHash: `0x${'b'.repeat(64)}`,
      originalFundingFingerprint: 'c'.repeat(64),
    });
    try {
      for (const service of ['oracle', 'gateway', 'treasury']) {
        const database = `${identity}_${service}`;
        await admin.query(`CREATE DATABASE ${database}`);
        const target = new URL(url);
        target.pathname = `/${database}`;
        const pool = new Pool({ connectionString: target.toString(), max: 1 });
        try {
          await pool.query(`SET app.runtime_db_user='${identity}'`);
          const root = path.resolve(__dirname, '..', service, 'src/database');
          const manifest = JSON.parse(fs.readFileSync(path.join(root, 'migrations.json'), 'utf8'));
          const args = {
            pool,
            serviceName: service,
            manifestPath: path.join(root, 'migrations.json'),
            runtimeDbUser: identity,
          };
          const applied = await runVersionedMigrations(args);
          assert.equal(applied.applied.length, manifest.migrations.length);
          assert.equal((await runVersionedMigrations(args)).applied.length, 0);
          assert.equal(
            await computePublicSchemaFingerprint(pool),
            manifest.migrations.at(-1).schema_sha256,
          );
          if (service === 'oracle') {
            const insert = (value, key = 'operation') =>
              pool.query(
                `INSERT INTO oracle_triggers(action_key,request_id,idempotency_key,trade_id,trigger_type,status,funded_binding) VALUES('RELEASE_STAGE_1:1','req-42',$1,'1','RELEASE_STAGE_1','PENDING',$2::jsonb) RETURNING funded_binding`,
                [key, value === null || value === undefined ? null : JSON.stringify(value)],
              );
            await assert.rejects(insert(null), /complete_original_funded_binding_required/);
            const row = await insert(binding);
            assert.deepEqual(row.rows[0].funded_binding, binding);
            await assert.rejects(
              pool.query(
                `UPDATE oracle_triggers SET funded_binding=jsonb_set(funded_binding,'{supplierAddress}',to_jsonb($1::text))`,
                [binding.buyerAddress],
              ),
              /oracle_funded_binding_is_immutable/,
            );
            await assert.rejects(
              pool.query(`UPDATE oracle_triggers SET trade_id='2'`),
              /oracle_funded_binding_is_immutable/,
            );
            await assert.rejects(
              pool.query('DELETE FROM oracle_triggers'),
              /oracle_funded_binding_is_retained/,
            );
            const claim = await pool.query(
              `UPDATE oracle_triggers SET dispatch_started_at=NOW(),dispatch_signer_scope='31337:0x3333333333333333333333333333333333333333',status='EXECUTING' WHERE idempotency_key='operation' AND dispatch_started_at IS NULL RETURNING id`,
            );
            assert.equal(claim.rowCount, 1);
            assert.equal(
              (
                await pool.query(
                  `UPDATE oracle_triggers SET dispatch_started_at=NOW() WHERE idempotency_key='operation' AND dispatch_started_at IS NULL RETURNING id`,
                )
              ).rowCount,
              0,
            );
            await assert.rejects(
              pool.query('UPDATE oracle_triggers SET dispatch_started_at=NULL'),
              /oracle_dispatch_claim_is_immutable/,
            );
            await pool.query(`UPDATE oracle_triggers SET status='SUBMITTED',tx_hash=$1`, [
              `0x${'d'.repeat(64)}`,
            ]);
            assert.deepEqual(
              (await pool.query('SELECT funded_binding FROM oracle_triggers')).rows[0]
                .funded_binding,
              binding,
            );
            await assert.rejects(
              pool.query(`UPDATE oracle_triggers SET tx_hash=$1`, [`0x${'e'.repeat(64)}`]),
              /oracle_original_transaction_is_immutable/,
            );
          } else if (service === 'gateway') {
            const insert = (value, serviceId = 'controlled-platform') =>
              pool.query(
                `INSERT INTO settlement_handoffs(handoff_id,platform_id,platform_handoff_id,trade_id,phase,settlement_channel,display_currency,display_amount,asset_symbol,asset_amount,ricardian_hash,external_reference,metadata,request_id,source_api_key_id,execution_binding,execution_status,reconciliation_status,callback_status) VALUES('sth-42','controlled-platform','42','1','initial_release_after_custody_and_documents','cotsel_escrow','USD',0.0005,'USDC',0.0005,$1,'1','{}','req-42',$2,$3::jsonb,'pending','pending','disabled') RETURNING execution_binding`,
                [
                  binding.ricardianHash,
                  serviceId,
                  value === null || value === undefined ? null : JSON.stringify(value),
                ],
              );
            await assert.rejects(
              insert(null),
              /complete_owned_funded_progression_binding_required/,
            );
            await assert.rejects(
              insert(binding, 'foreign-owner'),
              /complete_owned_funded_progression_binding_required/,
            );
            assert.deepEqual((await insert(binding)).rows[0].execution_binding, binding);
            await assert.rejects(
              pool.query(`UPDATE settlement_handoffs SET trade_id='2'`),
              /typed_execution_binding_identity_is_immutable/,
            );
            await assert.rejects(
              pool.query(`UPDATE settlement_handoffs SET execution_binding='{}'`),
              /typed_execution_binding_is_immutable/,
            );
            await assert.rejects(
              pool.query('DELETE FROM settlement_handoffs'),
              /typed_execution_binding_is_immutable/,
            );
            await pool.query(`UPDATE settlement_handoffs SET execution_status='submitted'`);
          } else {
            const period = await pool.query(
              `INSERT INTO accounting_periods(period_key,starts_at,ends_at,status,created_by) VALUES('controlled','2026-01-01','2027-01-01','OPEN','controlled-maker') RETURNING id`,
            );
            await pool.query(
              `INSERT INTO sweep_batches(batch_key,accounting_period_id,asset_symbol,status,expected_total_raw,payout_receiver_address,created_by,metadata) VALUES('controlled',$1,'USDC','DRAFT','1000000',$2,'controlled-maker',$3::jsonb)`,
              [
                period.rows[0].id,
                binding.supplierAddress,
                JSON.stringify({
                  settlementFinalizedEvidence: {
                    policyVersion: 'treasury_dual_rpc_finalized_v1',
                    blockHash: binding.fundingBlockHash,
                  },
                }),
              ],
            );
            await assert.rejects(
              pool.query(`UPDATE sweep_batches SET metadata='{}'`),
              /sweep_finalized_evidence_is_immutable/,
            );
            await assert.rejects(
              pool.query(`UPDATE sweep_batches SET payout_receiver_address=$1`, [
                binding.buyerAddress,
              ]),
              /sweep_finalized_evidence_is_immutable/,
            );
            await assert.rejects(
              pool.query('DELETE FROM sweep_batches'),
              /sweep_finalized_evidence_is_retained/,
            );
            await pool.query(
              `UPDATE sweep_batches SET metadata=metadata||'{"controlledNote":"retained evidence"}'::jsonb`,
            );
          }
        } finally {
          await pool.end();
          await admin.query(`DROP DATABASE ${database}`);
        }
      }
    } finally {
      await admin.query(`DROP ROLE ${identity}`);
      await admin.end();
    }
  },
);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPostgresOracleTransactionOutcomeStore } from '../src/database/transaction-outcome-store';

function requireTestDatabaseUrl(): string {
  const value = process.env.ORACLE_OUTCOME_PROOF_DATABASE_URL?.trim();
  if (!value) {
    throw new Error('ORACLE_OUTCOME_PROOF_DATABASE_URL is required');
  }
  const database = new URL(value).pathname.slice(1);
  if (!database.includes('test') && !database.startsWith('cotsel_oracle_wp2_')) {
    throw new Error('Transaction outcome proof requires an explicitly named test database');
  }
  return value;
}

async function run(): Promise<void> {
  const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
  const fixture = randomUUID().replace(/-/g, '');
  const triggerId = `RELEASE_STAGE_1:${fixture}:request`;
  const actionKey = `RELEASE_STAGE_1:${fixture}`;
  const transactionHash = `0x${fixture.padEnd(64, 'a').slice(0, 64)}`;
  const store = createPostgresOracleTransactionOutcomeStore(pool);

  try {
    await pool.query(
      `INSERT INTO oracle_triggers (
         action_key, request_id, idempotency_key, trade_id, trigger_type, status
       ) VALUES ($1, $2, $3, $4, 'RELEASE_STAGE_1', 'EXECUTING')`,
      [actionKey, 'request', triggerId, fixture],
    );
    await store.recordPrepared({
      transactionHash,
      triggerIdempotencyKey: triggerId,
      chainId: 84532,
      signerAddress: `0x${'1'.repeat(40)}`,
      nonce: 7,
      transactionType: 2,
      destinationAddress: `0x${'2'.repeat(40)}`,
      valueWei: '0',
      gasLimit: '210000',
      maxFeePerGasWei: '10',
      maxPriorityFeePerGasWei: '1',
      gasPriceWei: null,
      calldataHash: `0x${'3'.repeat(64)}`,
      intentHash: `0x${'4'.repeat(64)}`,
    });

    const prepared = await pool.query(
      `SELECT t.status, t.tx_hash, o.outcome_status
       FROM oracle_triggers t
       JOIN oracle_transaction_outcomes o
         ON o.trigger_idempotency_key = t.idempotency_key
       WHERE t.idempotency_key = $1`,
      [triggerId],
    );
    assert.deepEqual(prepared.rows[0], {
      status: 'BROADCAST_PENDING',
      tx_hash: transactionHash,
      outcome_status: 'broadcast_pending',
    });
    assert.deepEqual(
      (await store.listRecoveryCandidates(100)).map((candidate) => candidate.transactionHash),
      [transactionHash],
    );

    await store.markBroadcastUnknown(transactionHash, 'TIMEOUT');
    const unknown = await pool.query(
      `SELECT t.status, o.outcome_status, o.failure_code
       FROM oracle_triggers t
       JOIN oracle_transaction_outcomes o
         ON o.trigger_idempotency_key = t.idempotency_key
       WHERE t.idempotency_key = $1`,
      [triggerId],
    );
    assert.deepEqual(unknown.rows[0], {
      status: 'BROADCAST_UNKNOWN',
      outcome_status: 'broadcast_unknown',
      failure_code: 'TIMEOUT',
    });
    assert.deepEqual(
      (await store.listRecoveryCandidates(100)).map((candidate) => candidate.transactionHash),
      [transactionHash],
    );

    await store.markConfirmationPending(transactionHash, 1234);
    const submitted = await pool.query(
      `SELECT t.status, t.block_number::text, o.outcome_status, o.block_number::text
       FROM oracle_triggers t
       JOIN oracle_transaction_outcomes o
         ON o.trigger_idempotency_key = t.idempotency_key
       WHERE t.idempotency_key = $1`,
      [triggerId],
    );
    assert.deepEqual(submitted.rows[0], {
      status: 'SUBMITTED',
      block_number: '1234',
      outcome_status: 'confirmation_pending',
    });
    assert.deepEqual(
      (await store.listRecoveryCandidates(100)).map((candidate) => candidate.transactionHash),
      [transactionHash],
    );

    process.stdout.write(
      JSON.stringify({
        result: 'VERIFIED',
        chainId: 84532,
        transitions: ['BROADCAST_PENDING', 'BROADCAST_UNKNOWN', 'SUBMITTED'],
        recoveryStatuses: ['broadcast_pending', 'broadcast_unknown', 'confirmation_pending'],
      }) + '\n',
    );
  } finally {
    await pool.query('DELETE FROM oracle_transaction_outcomes WHERE trigger_idempotency_key = $1', [
      triggerId,
    ]);
    await pool.query('DELETE FROM oracle_triggers WHERE idempotency_key = $1', [triggerId]);
    await pool.end();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

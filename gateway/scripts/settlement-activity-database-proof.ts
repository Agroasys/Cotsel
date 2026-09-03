/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';
import { createPostgresIdempotencyStore } from '../src/core/idempotencyStore';
import { createPostgresSettlementStore } from '../src/core/settlementStore';

const ACTIVITY_COUNT = 64;
const MIGRATION_MANIFEST_PATH = path.resolve(__dirname, '../src/database/migrations.json');
const GATEWAY_RUNTIME_DB_USER = 'cotsel_gateway_runtime';

function requireDisposableDatabaseUrl(): string {
  const value = process.env.SETTLEMENT_ACTIVITY_DATABASE_URL?.trim();
  if (!value) {
    throw new Error('SETTLEMENT_ACTIVITY_DATABASE_URL is required.');
  }

  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\/+/, '');
  if (!/(?:^|[_-])(test|verify)(?:$|[_-])/i.test(databaseName)) {
    throw new Error(
      `Refusing to run the settlement activity proof against non-test database '${databaseName}'.`,
    );
  }

  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function main(): Promise<void> {
  const databaseUrl = requireDisposableDatabaseUrl();
  const token = randomUUID();
  const shortToken = token.replace(/-/g, '').slice(0, 16);
  const platformId = `activity-proof-${shortToken}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 24 });

  try {
    await runVersionedMigrations({
      pool,
      serviceName: 'gateway',
      manifestPath: MIGRATION_MANIFEST_PATH,
      runtimeDbUser: GATEWAY_RUNTIME_DB_USER,
    });
    const store = createPostgresSettlementStore(pool);

    const handoffs = await Promise.all(
      Array.from({ length: ACTIVITY_COUNT }, (_, index) =>
        store.createHandoff({
          platformId,
          platformHandoffId: `order-${shortToken}-${index}`,
          tradeId: String(10_000 + index),
          phase: 'final_release_after_inspection',
          settlementChannel: 'web3',
          displayCurrency: 'USD',
          displayAmount: 1_000 + index,
          assetSymbol: 'USDC',
          assetAmount: 1_000 + index,
          ricardianHash: sha256(`${token}:ricardian:${index}`),
          externalReference: `invoice-${shortToken}-${index}`,
          metadata: {
            activityIndex: index,
            orderId: 50_000 + index,
            invoiceNumber: `INV-${shortToken}-${index}`,
            amountBaseUnits: String(BigInt(1_000 + index) * 1_000_000n),
          },
          requestId: `create-${shortToken}-${index}`,
          sourceApiKeyId: 'activity-database-proof',
        }),
      ),
    );

    const replayPairs = await Promise.all(
      handoffs.map(async (handoff, index) => {
        const input = {
          handoffId: handoff.handoffId,
          eventType: 'submitted' as const,
          executionStatus: 'submitted' as const,
          reconciliationStatus: 'pending' as const,
          providerStatus: 'submitted',
          txHash: `0x${sha256(`${token}:tx:${index}`)}`,
          detail: `activity ${index} submitted`,
          metadata: {
            activityIndex: index,
            orderId: 50_000 + index,
            amountBaseUnits: String(BigInt(1_000 + index) * 1_000_000n),
          },
          observedAt: new Date(Date.now() + index).toISOString(),
          requestId: `event-${shortToken}-${index}`,
          sourceApiKeyId: 'activity-database-proof',
          dedupeKey: `submitted-${shortToken}-${index}`,
        };
        const callback = {
          targetUrl: 'https://agroasys.example.test/settlement/callback',
          requestId: `callback-${shortToken}-${index}`,
          status: 'pending' as const,
          nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
          buildRequestBody: () => ({
            platformHandoffId: handoff.platformHandoffId,
            tradeId: handoff.tradeId,
            displayAmount: handoff.displayAmount,
            ricardianHash: handoff.ricardianHash,
            activityIndex: index,
            orderId: 50_000 + index,
            invoiceNumber: `INV-${shortToken}-${index}`,
          }),
        };

        return Promise.all([
          store.recordExecutionEvent(input, callback),
          store.recordExecutionEvent(input, callback),
        ]);
      }),
    );

    for (const [first, replay] of replayPairs) {
      if (
        first.event.eventId !== replay.event.eventId ||
        first.callbackDelivery.deliveryId !== replay.callbackDelivery.deliveryId
      ) {
        throw new Error('An idempotent event replay created a duplicate event or callback.');
      }
    }

    const rows = await pool.query<{
      platformHandoffId: string;
      tradeId: string;
      displayAmount: string;
      ricardianHash: string;
      externalReference: string;
      handoffMetadata: {
        activityIndex: number;
        orderId: number;
        invoiceNumber: string;
        amountBaseUnits: string;
      };
      eventMetadata: {
        activityIndex: number;
        orderId: number;
        amountBaseUnits: string;
      };
      requestBody: {
        platformHandoffId: string;
        tradeId: string;
        displayAmount: number;
        ricardianHash: string;
        activityIndex: number;
        orderId: number;
        invoiceNumber: string;
      };
    }>(
      `SELECT
         h.platform_handoff_id AS "platformHandoffId",
         h.trade_id AS "tradeId",
         h.display_amount::text AS "displayAmount",
         h.ricardian_hash AS "ricardianHash",
         h.external_reference AS "externalReference",
         h.metadata AS "handoffMetadata",
         e.metadata AS "eventMetadata",
         c.request_body AS "requestBody"
       FROM settlement_handoffs h
       JOIN settlement_execution_events e ON e.handoff_id = h.handoff_id
       JOIN settlement_callback_deliveries c ON c.event_id = e.event_id
       WHERE h.platform_id = $1
       ORDER BY (h.metadata ->> 'activityIndex')::integer`,
      [platformId],
    );

    if (rows.rowCount !== ACTIVITY_COUNT) {
      throw new Error(
        `Expected ${ACTIVITY_COUNT} atomic handoff/event/callback rows; received ${rows.rowCount}.`,
      );
    }

    for (let index = 0; index < rows.rows.length; index += 1) {
      const row = rows.rows[index]!;
      const expectedOrderId = 50_000 + index;
      const expectedAmount = 1_000 + index;
      const expectedBaseUnits = String(BigInt(expectedAmount) * 1_000_000n);
      const expectedHash = sha256(`${token}:ricardian:${index}`);
      const expectedPlatformHandoffId = `order-${shortToken}-${index}`;
      const expectedInvoiceNumber = `INV-${shortToken}-${index}`;

      if (
        row.platformHandoffId !== expectedPlatformHandoffId ||
        row.tradeId !== String(10_000 + index) ||
        Number(row.displayAmount) !== expectedAmount ||
        row.ricardianHash !== expectedHash ||
        row.externalReference !== `invoice-${shortToken}-${index}` ||
        row.handoffMetadata.activityIndex !== index ||
        row.handoffMetadata.orderId !== expectedOrderId ||
        row.handoffMetadata.invoiceNumber !== expectedInvoiceNumber ||
        row.handoffMetadata.amountBaseUnits !== expectedBaseUnits ||
        row.eventMetadata.activityIndex !== index ||
        row.eventMetadata.orderId !== expectedOrderId ||
        row.eventMetadata.amountBaseUnits !== expectedBaseUnits ||
        row.requestBody.platformHandoffId !== expectedPlatformHandoffId ||
        row.requestBody.tradeId !== String(10_000 + index) ||
        row.requestBody.displayAmount !== expectedAmount ||
        row.requestBody.ricardianHash !== expectedHash ||
        row.requestBody.activityIndex !== index ||
        row.requestBody.orderId !== expectedOrderId ||
        row.requestBody.invoiceNumber !== expectedInvoiceNumber
      ) {
        throw new Error(`Settlement identity or amount crossed activity boundary ${index}.`);
      }
    }

    const idempotencyStore = createPostgresIdempotencyStore(pool);
    const outcomeStore = createPostgresGaslessTransactionOutcomeRecorder(pool);
    const outcomeRequestId = `outcome-${shortToken}`;
    const outcomeHash = `0x${sha256(`${token}:outcome`)}`;
    const idempotencyScope = {
      actorId: 'service:activity-database-proof',
      endpoint: '/settlement/gasless-executions/create-trade',
      idempotencyKey: `outcome-idempotency-${shortToken}`,
    };
    const idempotencyReservation = await idempotencyStore.createPending({
      ...idempotencyScope,
      requestMethod: 'POST',
      requestPath: '/settlement/gasless-executions/create-trade',
      requestFingerprint: sha256(`${token}:request-fingerprint`),
      requestId: outcomeRequestId,
    });
    await outcomeStore.recordPrepared({
      transactionHash: outcomeHash,
      applicationRequestId: outcomeRequestId,
      resourceType: 'settlement_handoff',
      resourceId: handoffs[0]!.handoffId,
      operation: 'create_trade',
      chainId: 84532,
      signerAddress: `0x${'1'.repeat(40)}`,
      nonce: 7,
      transactionType: 2,
      destinationAddress: `0x${'2'.repeat(40)}`,
      valueWei: '0',
      gasLimit: '210000',
      maxFeePerGasWei: '2',
      maxPriorityFeePerGasWei: '1',
      gasPriceWei: null,
      calldataHash: `0x${sha256(`${token}:calldata`)}`,
      intentHash: `0x${sha256(`${token}:intent`)}`,
    });
    await idempotencyStore.releasePending(
      idempotencyScope,
      idempotencyReservation.record.requestId,
    );
    if (!(await idempotencyStore.get(idempotencyScope))) {
      throw new Error('Idempotency reservation was released after financial identity persisted.');
    }

    await outcomeStore.markBroadcastUnknown(outcomeHash, 'DATABASE_PROOF_INJECTED_TIMEOUT');
    await outcomeStore.markConfirmationPending(outcomeHash);
    await outcomeStore.markConfirmed(outcomeHash, {
      blockNumber: '12345',
      blockHash: `0x${sha256(`${token}:block`)}`,
      gasUsed: '210000',
      effectiveGasPriceWei: '2',
    });
    const outcomeRows = await pool.query<{
      outcomeStatus: string;
      eventCount: string;
      applicationRequestId: string;
    }>(
      `SELECT
         outcome.outcome_status AS "outcomeStatus",
         outcome.application_request_id AS "applicationRequestId",
         COUNT(event.outcome_event_id)::text AS "eventCount"
       FROM gasless_transaction_outcomes outcome
       JOIN gasless_transaction_outcome_events event
         ON event.transaction_hash = outcome.transaction_hash
       WHERE outcome.transaction_hash = $1
       GROUP BY outcome.outcome_status, outcome.application_request_id`,
      [outcomeHash],
    );
    if (
      outcomeRows.rows[0]?.outcomeStatus !== 'confirmed' ||
      outcomeRows.rows[0]?.applicationRequestId !== outcomeRequestId ||
      outcomeRows.rows[0]?.eventCount !== '4'
    ) {
      throw new Error('Gasless outcome state or append-only event history is incomplete.');
    }

    await expectTransitionRejected(
      () => outcomeStore.markConfirmationPending(outcomeHash),
      'terminal gasless outcome transitioned back to confirmation_pending',
    );

    process.stdout.write(
      `${JSON.stringify({
        status: 'passed',
        activities: ACTIVITY_COUNT,
        handoffs: rows.rowCount,
        concurrentEventAttempts: ACTIVITY_COUNT * 2,
        durableEvents: rows.rowCount,
        atomicCallbackOutboxRows: rows.rowCount,
        duplicateEvents: 0,
        duplicateCallbacks: 0,
        retainedEvidenceRows: true,
        gaslessIdentityPersistedBeforeOutcome: true,
        gaslessOutcomeEvents: 4,
        terminalOutcomeImmutable: true,
        idempotencyRetainedAcrossUnknownOutcome: true,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

async function expectTransitionRejected(
  operation: () => Promise<void>,
  failureMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(failureMessage);
}

void main().catch((error) => {
  process.stderr.write(
    `Cotsel settlement activity database proof failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

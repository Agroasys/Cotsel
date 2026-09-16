/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import {
  createPostgresGaslessNonceReservationStore,
  type GaslessNonceReservationInput,
} from '../src/core/gaslessNonceReservationStore';
import { dockerAvailable, withGovernancePostgres } from './helpers/governancePostgresHarness';

const describePostgres = dockerAvailable ? describe : describe.skip;
const signerAddress = '0x1111111111111111111111111111111111111111';

function connection(port: number) {
  return {
    host: '127.0.0.1',
    port,
    database: 'gateway_test',
    user: 'gateway_runtime',
    password: 'gateway-runtime-test',
    max: 2,
  };
}

function reservationInput(
  overrides: Partial<GaslessNonceReservationInput> = {},
): GaslessNonceReservationInput {
  return {
    chainId: 84532,
    signerAddress,
    transactionNonce: 17,
    requestId: 'signing-request-1',
    applicationRequestId: 'application-request-1',
    resourceType: 'settlement_handoff',
    resourceId: 'handoff-1',
    operation: 'open_dispute',
    intentHash: `0x${'1'.repeat(64)}`,
    ...overrides,
  };
}

describePostgres('PostgreSQL gasless nonce reservations', () => {
  jest.setTimeout(120_000);

  test('allows only one of two independent replicas to reserve the same signer nonce', async () => {
    await withGovernancePostgres(async (port) => {
      const firstPool = new Pool(connection(port));
      const secondPool = new Pool(connection(port));
      try {
        const firstStore = createPostgresGaslessNonceReservationStore(firstPool);
        const secondStore = createPostgresGaslessNonceReservationStore(secondPool);
        const attempts = await Promise.allSettled([
          firstStore.reserve(reservationInput()),
          secondStore.reserve(
            reservationInput({
              requestId: 'signing-request-2',
              applicationRequestId: 'application-request-2',
              resourceId: 'handoff-2',
              intentHash: `0x${'2'.repeat(64)}`,
            }),
          ),
        ]);

        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
        const row = await firstPool.query(
          `SELECT COUNT(*)::integer AS count
           FROM gasless_nonce_reservations
           WHERE chain_id = $1 AND signer_address = $2 AND transaction_nonce = $3`,
          [84532, signerAddress, 17],
        );
        expect(row.rows[0].count).toBe(1);
      } finally {
        await Promise.all([firstPool.end(), secondPool.end()]);
      }
    });
  });

  test('recovers only an expired unsigned reservation for the exact same intent', async () => {
    await withGovernancePostgres(async (port) => {
      const runtimePool = new Pool(connection(port));
      const adminPool = new Pool({ ...connection(port), user: 'postgres', password: 'postgres' });
      try {
        const firstStore = createPostgresGaslessNonceReservationStore(runtimePool, 60, 2);
        const secondStore = createPostgresGaslessNonceReservationStore(runtimePool, 60, 2);
        const original = await firstStore.reserve(reservationInput());
        await adminPool.query(
          `UPDATE gasless_nonce_reservations
           SET lease_expires_at = NOW() - INTERVAL '1 second'
           WHERE reservation_id = $1`,
          [original.reservationId],
        );

        await expect(
          secondStore.reserve(
            reservationInput({
              requestId: 'different-request',
              applicationRequestId: 'different-application-request',
              intentHash: `0x${'3'.repeat(64)}`,
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

        const recovered = await secondStore.reserve(reservationInput());
        expect(recovered.reservationId).toBe(original.reservationId);
        expect(recovered.leaseToken).not.toBe(original.leaseToken);
        const row = await runtimePool.query(
          `SELECT recovery_count AS "recoveryCount"
           FROM gasless_nonce_reservations WHERE reservation_id = $1`,
          [original.reservationId],
        );
        expect(row.rows[0].recoveryCount).toBe(1);
      } finally {
        await Promise.all([runtimePool.end(), adminPool.end()]);
      }
    });
  });

  test('quarantines a signing reservation and records exactly one signed transaction', async () => {
    await withGovernancePostgres(async (port) => {
      const runtimePool = new Pool(connection(port));
      try {
        const store = createPostgresGaslessNonceReservationStore(runtimePool);
        const value = await store.reserve(reservationInput());
        await store.beginSigning(value);
        await expect(store.reserve(reservationInput())).rejects.toMatchObject({
          statusCode: 409,
          code: 'CONFLICT',
        });

        const transactionHash = `0x${'a'.repeat(64)}`;
        await store.recordSigned(value, transactionHash);
        await expect(store.recordSigned(value, `0x${'b'.repeat(64)}`)).rejects.toThrow(
          'cannot accept another signed transaction',
        );

        const row = await runtimePool.query(
          `SELECT reservation_status AS status,
                  signed_transaction_hash AS "transactionHash"
           FROM gasless_nonce_reservations WHERE reservation_id = $1`,
          [value.reservationId],
        );
        expect(row.rows[0]).toEqual({ status: 'signed', transactionHash });
      } finally {
        await runtimePool.end();
      }
    });
  });
});

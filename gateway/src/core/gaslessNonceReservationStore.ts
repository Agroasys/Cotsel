/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { getAddress } from 'ethers';
import type { Pool, PoolClient } from 'pg';
import { GatewayError } from '../errors';

export interface GaslessNonceReservationInput {
  chainId: number;
  signerAddress: string;
  transactionNonce: number;
  requestId: string;
  applicationRequestId: string;
  resourceType: 'settlement_handoff' | 'platform_transfer';
  resourceId: string;
  operation: string;
  intentHash: string;
}

export interface GaslessNonceReservation {
  reservationId: string;
  leaseToken: string;
  chainId: number;
  signerAddress: string;
  transactionNonce: number;
  requestId: string;
  intentHash: string;
}

export interface GaslessNonceReservationStore {
  reserve(input: GaslessNonceReservationInput): Promise<GaslessNonceReservation>;
  beginSigning(reservation: GaslessNonceReservation): Promise<void>;
  recordSigned(reservation: GaslessNonceReservation, transactionHash: string): Promise<void>;
}

interface ReservationRow {
  reservationId: string;
  leaseToken: string;
  chainId: string;
  signerAddress: string;
  transactionNonce: string;
  requestId: string;
  intentHash: string;
}

function canonicalInput(input: GaslessNonceReservationInput): GaslessNonceReservationInput {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
    throw new Error('Gasless nonce reservation chainId must be a positive integer');
  }
  if (!Number.isSafeInteger(input.transactionNonce) || input.transactionNonce < 0) {
    throw new Error('Gasless nonce reservation transactionNonce must be a non-negative integer');
  }
  return {
    ...input,
    signerAddress: getAddress(input.signerAddress).toLowerCase(),
    requestId: input.requestId.trim(),
    applicationRequestId: input.applicationRequestId.trim(),
    resourceId: input.resourceId.trim(),
    operation: input.operation.trim(),
    intentHash: input.intentHash.toLowerCase(),
  };
}

function reservation(row: ReservationRow): GaslessNonceReservation {
  return {
    reservationId: row.reservationId,
    leaseToken: row.leaseToken,
    chainId: Number(row.chainId),
    signerAddress: row.signerAddress,
    transactionNonce: Number(row.transactionNonce),
    requestId: row.requestId,
    intentHash: row.intentHash,
  };
}

function conflict(input: GaslessNonceReservationInput): never {
  throw new GatewayError(
    409,
    'CONFLICT',
    'Gasless signer nonce is already reserved by another transaction intent',
    {
      chainId: input.chainId,
      signerAddress: input.signerAddress,
      transactionNonce: input.transactionNonce,
    },
  );
}

async function addEvent(
  client: PoolClient,
  value: GaslessNonceReservation,
  status: 'reserved' | 'signing' | 'signed',
  transactionHash?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO gasless_nonce_reservation_events (
       reservation_id, reservation_status, recovery_count, signed_transaction_hash
     )
     SELECT reservation_id, $3, recovery_count, $4
     FROM gasless_nonce_reservations
     WHERE reservation_id = $1 AND lease_token = $2`,
    [value.reservationId, value.leaseToken, status, transactionHash ?? null],
  );
}

export function createPostgresGaslessNonceReservationStore(
  pool: Pool,
  leaseSeconds = 60,
  maximumRecoveries = 3,
): GaslessNonceReservationStore {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error('Gasless nonce reservation leaseSeconds must be positive');
  }
  if (!Number.isInteger(maximumRecoveries) || maximumRecoveries < 0) {
    throw new Error('Gasless nonce reservation maximumRecoveries must be non-negative');
  }

  return {
    async reserve(untrustedInput) {
      const input = canonicalInput(untrustedInput);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reservationId = randomUUID();
        const leaseToken = randomUUID();
        let result = await client.query<ReservationRow>(
          `INSERT INTO gasless_nonce_reservations (
             reservation_id, chain_id, signer_address, transaction_nonce,
             request_id, application_request_id, resource_type, resource_id,
             operation, intent_hash, reservation_status, lease_token, lease_expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11,
             NOW() + ($12 * INTERVAL '1 second')
           )
           ON CONFLICT (chain_id, signer_address, transaction_nonce) DO NOTHING
           RETURNING reservation_id AS "reservationId", lease_token AS "leaseToken",
             chain_id AS "chainId", signer_address AS "signerAddress",
             transaction_nonce AS "transactionNonce", request_id AS "requestId",
             intent_hash AS "intentHash"`,
          [
            reservationId,
            input.chainId,
            input.signerAddress,
            input.transactionNonce,
            input.requestId,
            input.applicationRequestId,
            input.resourceType,
            input.resourceId,
            input.operation,
            input.intentHash,
            leaseToken,
            leaseSeconds,
          ],
        );
        if (result.rowCount !== 1) {
          result = await client.query<ReservationRow>(
            `UPDATE gasless_nonce_reservations
             SET lease_token = $11, lease_expires_at = NOW() + ($12 * INTERVAL '1 second'),
                 recovery_count = recovery_count + 1, updated_at = NOW()
             WHERE chain_id = $2 AND signer_address = $3 AND transaction_nonce = $4
               AND $1::uuid IS NOT NULL
               AND request_id = $5 AND application_request_id = $6
               AND resource_type = $7 AND resource_id = $8 AND operation = $9
               AND intent_hash = $10 AND reservation_status = 'reserved'
               AND lease_expires_at <= NOW() AND recovery_count < $13
             RETURNING reservation_id AS "reservationId", lease_token AS "leaseToken",
               chain_id AS "chainId", signer_address AS "signerAddress",
               transaction_nonce AS "transactionNonce", request_id AS "requestId",
               intent_hash AS "intentHash"`,
            [
              reservationId,
              input.chainId,
              input.signerAddress,
              input.transactionNonce,
              input.requestId,
              input.applicationRequestId,
              input.resourceType,
              input.resourceId,
              input.operation,
              input.intentHash,
              leaseToken,
              leaseSeconds,
              maximumRecoveries,
            ],
          );
        }
        if (result.rowCount !== 1) conflict(input);
        const value = reservation(result.rows[0]);
        await addEvent(client, value, 'reserved');
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async beginSigning(value) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE gasless_nonce_reservations
           SET reservation_status = 'signing', lease_expires_at = NULL,
               signing_started_at = NOW(), updated_at = NOW()
           WHERE reservation_id = $1 AND lease_token = $2
             AND reservation_status = 'reserved' AND lease_expires_at > NOW()`,
          [value.reservationId, value.leaseToken],
        );
        if (result.rowCount !== 1) {
          throw new GatewayError(409, 'CONFLICT', 'Gasless nonce reservation is no longer active');
        }
        await addEvent(client, value, 'signing');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async recordSigned(value, transactionHash) {
      const normalizedHash = transactionHash.toLowerCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE gasless_nonce_reservations
           SET reservation_status = 'signed', signed_transaction_hash = $3,
               signed_at = NOW(), updated_at = NOW()
           WHERE reservation_id = $1 AND lease_token = $2
             AND reservation_status = 'signing' AND signed_transaction_hash IS NULL`,
          [value.reservationId, value.leaseToken, normalizedHash],
        );
        if (result.rowCount !== 1) {
          throw new Error('Gasless nonce reservation cannot accept another signed transaction');
        }
        await addEvent(client, value, 'signed', normalizedHash);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

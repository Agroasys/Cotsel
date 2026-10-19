/** SPDX-License-Identifier: Apache-2.0 */
// Test-only read composition. No signing, broadcast, retirement persistence or owner transfer.
import type { Pool } from 'pg';
import type { GaslessUserActionExecutionInput } from '../../src/core/gaslessExecutionTypes';
import type { UserActionInventoryRequest } from '../../src/core/userActionEngine/inventory';
import { validateInventoryRequest } from '../../src/core/userActionEngine/inventoryValidation';
import {
  nonceInventory,
  validateUserActionRetirementEvidence,
  type UserActionRetirementScope,
  type UserActionRetirementEvidence,
  type VerifyUserActionRetirement,
} from '../../src/core/userActionEngine/retirement';
import { fingerprint, requestIdentity } from '../../src/core/userActionEngine/validation';
import {
  createUserActionRetirementTransport,
  type UserActionRetirementTransportConfig,
} from '../../src/core/userActionEngine/retirementTransport';

async function retainedScope(pool: Pool, input: GaslessUserActionExecutionInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const inventory = await nonceInventory(client, input);
    const current = inventory.requests.find((row) => row.requestId === inventory.current);
    const row = inventory.requests.find(
      (row) =>
        row.ownerServiceId === input.sourceApiKeyId &&
        row.sourceOperationId === input.sourceOperationId,
    ) as UserActionInventoryRequest | undefined;
    if (!current || !row || inventory.history.some((event) => event.event_type === 'drift'))
      throw new Error('Retained request required');
    validateInventoryRequest(row, input.sourceApiKeyId!);
    if (
      row.requestFingerprint !== requestIdentity(input).fingerprint ||
      row.handoffId !== input.handoffId ||
      row.packageId !== input.actionPackageId
    )
      throw new Error('Pinned request mismatch');
    const scope: UserActionRetirementScope = {
      requestId: row.requestId,
      ownerServiceId: row.ownerServiceId,
      sourceOperationId: row.sourceOperationId,
      packageId: row.packageId,
      requestFingerprint: row.requestFingerprint,
      bindingFingerprint: row.bindingFingerprint,
      originalFundingFingerprint: row.binding.originalFundingFingerprint,
      chainId: Number(row.chainId),
      escrowAddress: row.escrowAddress,
      userAddress: row.userAddress,
      nonce: row.nonce,
      deadline: row.binding.deadline,
      inventoryFingerprint: fingerprint(row),
      priorRetirements: inventory.history
        .filter(
          (event) =>
            event.event_type === 'retired' && event.predecessor_request_id === row.requestId,
        )
        .map((event) => {
          const evidence = event.evidence as UserActionRetirementEvidence;
          validateUserActionRetirementEvidence(evidence, evidence.scope);
          if (
            evidence.scope.requestId !== row.requestId ||
            evidence.scope.ownerServiceId !== row.ownerServiceId ||
            evidence.scope.sourceOperationId !== row.sourceOperationId ||
            evidence.scope.packageId !== row.packageId ||
            evidence.scope.requestFingerprint !== row.requestFingerprint ||
            evidence.scope.bindingFingerprint !== row.bindingFingerprint ||
            evidence.scope.originalFundingFingerprint !== row.binding.originalFundingFingerprint ||
            evidence.scope.chainId !== Number(row.chainId) ||
            evidence.scope.escrowAddress !== row.escrowAddress ||
            evidence.scope.userAddress !== row.userAddress ||
            evidence.scope.nonce !== row.nonce ||
            evidence.scope.deadline !== row.binding.deadline
          )
            throw new Error('Retained retirement mismatch');
          return { anchor: evidence.anchor, financialOutcome: evidence.financialOutcome };
        }),
    };
    await client.query('COMMIT');
    return { scope, snapshot: fingerprint(inventory) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyPairedLifecycleRetirement(
  pool: Pool,
  input: GaslessUserActionExecutionInput,
  config: UserActionRetirementTransportConfig,
): ReturnType<VerifyUserActionRetirement> {
  const checkedAt = Date.now();
  try {
    const before = await retainedScope(pool, input);
    if (Date.now() < checkedAt || Date.now() - checkedAt > 10_000) return { status: 'unavailable' };
    // The real transport owns HMAC, strict bounded response parsing and exact proof validation.
    // Its network call occurs after the read-only snapshot transaction has committed.
    const result = await createUserActionRetirementTransport(config)(before.scope);
    if (Date.now() < checkedAt || Date.now() - checkedAt > 10_000) return { status: 'unavailable' };
    const after = await retainedScope(pool, input);
    if (
      before.snapshot !== after.snapshot ||
      Date.now() < checkedAt ||
      Date.now() - checkedAt > 10_000
    )
      return { status: 'unavailable' };
    return result;
  } catch {
    return { status: 'unavailable' };
  }
}

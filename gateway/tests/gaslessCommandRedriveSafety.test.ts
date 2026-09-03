/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  GaslessSettlementExecutionService,
  type GaslessSettlementExecutor,
} from '../src/core/gaslessSettlementExecutionService';
import { createInMemoryGaslessTransactionOutcomeStore } from '../src/core/inMemoryGaslessTransactionOutcomeStore';
import { createInMemorySettlementStore } from '../src/core/settlementStore';
import { SettlementService } from '../src/core/settlementService';
import { config } from './helpers/gaslessManagedSignerFixtures';

describe('gasless command operator redrive safety', () => {
  test('refuses redrive when transaction reconciliation owns the command', async () => {
    const store = createInMemorySettlementStore();
    const transactionOutcomeStore = createInMemoryGaslessTransactionOutcomeStore();
    const applicationRequestId = 'request-redrive-outcome-fence';
    const command = await store.enqueueCommand({
      applicationRequestId,
      intentKey: 'a'.repeat(64),
      resourceType: 'platform_transfer',
      resourceId: 'transfer-redrive-outcome-fence',
      operation: 'wallet_usdc_transfer',
      payload: { requestId: applicationRequestId },
      maxAttempts: 1,
      maxQueueDepth: 10,
      nextAttemptAt: '2026-08-29T00:00:00.000Z',
    });
    await store.claimDueCommand(
      'failed-worker',
      '2026-08-29T00:00:01.000Z',
      '2026-08-29T00:00:31.000Z',
    );
    await store.markFailed(
      command.commandId,
      'failed-worker',
      '2026-08-29T00:00:02.000Z',
      'WORKER_CRASHED',
      'Worker stopped after transaction identity persistence',
      '2026-08-29T00:00:10.000Z',
      true,
    );
    const transactionHash = `0x${'8'.repeat(64)}`;
    await transactionOutcomeStore.recordPrepared({
      transactionHash,
      applicationRequestId,
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      operation: command.operation,
      chainId: config.chainId,
      signerAddress: '0x1111111111111111111111111111111111111111',
      nonce: 8,
      transactionType: 2,
      destinationAddress: config.escrowAddress,
      valueWei: '0',
      gasLimit: '210000',
      maxFeePerGasWei: '1',
      maxPriorityFeePerGasWei: '1',
      gasPriceWei: null,
      calldataHash: `0x${'7'.repeat(64)}`,
      intentHash: `0x${'6'.repeat(64)}`,
    });
    const service = new GaslessSettlementExecutionService(
      new SettlementService(config, store),
      store,
      {} as GaslessSettlementExecutor,
      transactionOutcomeStore,
      {
        chainId: config.chainId,
        escrowAddress: config.escrowAddress,
        usdcAddress: config.usdcAddress,
        requestMaxTtlSeconds: 900,
      },
    );

    await expect(
      service.redriveDeadLetterCommand(command.commandId, {
        route: '/operations/gasless-relayer/dead-letters/:commandId/redrive',
        method: 'POST',
        idempotencyKey: 'redrive-outcome-fence',
        requestContext: {
          requestId: 'request-redrive-outcome-fence',
          correlationId: 'correlation-redrive-outcome-fence',
        },
        principal: {
          sessionReference: 'session-redrive-operator',
          session: {
            userId: 'redrive-operator',
            walletAddress: null,
            role: 'admin',
            capabilities: ['operations:replay'],
            signerAuthorizations: [],
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
          gatewayRoles: ['operator:read', 'operator:write'],
          operatorActionCapabilities: ['operations:replay'],
          treasuryCapabilities: [],
          writeEnabled: true,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      details: expect.objectContaining({ transactionHash, rebroadcastAllowed: false }),
    });
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
    });
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Interface } from 'ethers';
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { testExports as gaslessSettlementExecutionTestExports } from '../src/core/gaslessSettlementExecutionService';
import {
  buildCreateTradeInput,
  buildUserActionInput,
  config,
  createFakeManagedSignerDependencies,
  managedSignerWallet,
} from './helpers/gaslessManagedSignerFixtures';
import type {
  FakeManagedSignerResponse,
  FakeManagedSignerTransaction,
} from './helpers/gaslessManagedSignerFixtures';

async function expectGatewayError(
  promise: Promise<unknown>,
  expected: {
    statusCode: number;
    code: string;
    message: string;
  },
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toMatchObject({
    statusCode: expected.statusCode,
    code: expected.code,
  });
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe(expected.message);
}

describe('managed signer gasless execution safety', () => {
  test('managed custody executor delegates signing without requiring a raw private key', async () => {
    const dependencies = createFakeManagedSignerDependencies();
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          usdcAddress: config.usdcAddress,
          gaslessSignerCustodyMode: 'kms',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMaxGasLimit: 1_500_000n,
          gaslessMaxFeePerGasWei: 10n,
          gaslessMaxNativeCostWei: 10_000_000n,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );
    const input = buildCreateTradeInput('handoff-managed', 'a');

    const result = await executor.executeCreateTrade(input);

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        custodyMode: 'kms',
        operation: 'create_trade',
        signerAddress: managedSignerWallet.address,
        requestId: expect.any(String),
        intentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        transaction: expect.objectContaining({
          chainId: config.chainId,
          to: config.escrowAddress,
          nonce: 7,
          gasLimit: '210000',
          maxFeePerGasWei: '1',
          type: 2,
        }),
        policyContext: expect.objectContaining({
          kind: 'create_trade',
          resourceId: input.handoffId,
          actorAddress: input.buyerAddress,
        }),
      }),
    );
    expect(dependencies.nonceReservationStore.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: config.chainId,
        signerAddress: managedSignerWallet.address,
        transactionNonce: 7,
        applicationRequestId: input.requestId,
        resourceId: input.handoffId,
        operation: 'create_trade',
        intentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      }),
    );
    expect(dependencies.nonceReservationStore.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.nonceReservationStore.beginSigning.mock.invocationCallOrder[0],
    );
    expect(
      dependencies.nonceReservationStore.beginSigning.mock.invocationCallOrder[0],
    ).toBeLessThan(dependencies.signerTransport.signTransaction.mock.invocationCallOrder[0]);
    expect(dependencies.nonceReservationStore.recordSigned).toHaveBeenCalledWith(
      expect.objectContaining({ transactionNonce: 7 }),
      result.txHash,
    );
    expect(dependencies.signerTransport.signTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.nonceReservationStore.recordSigned.mock.invocationCallOrder[0],
    );
    expect(
      dependencies.nonceReservationStore.recordSigned.mock.invocationCallOrder[0],
    ).toBeLessThan(dependencies.provider.broadcastTransaction.mock.invocationCallOrder[0]);
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledWith(
      expect.stringMatching(/^0x[0-9a-f]+$/),
    );
    expect(dependencies.recordValidationEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'accepted',
        intentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        operation: 'create_trade',
        applicationRequestId: input.requestId,
        resourceId: input.handoffId,
      }),
    );
    expect(dependencies.recordValidationEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.provider.broadcastTransaction.mock.invocationCallOrder[0],
    );
    expect(dependencies.recordTransactionOutcome.recordPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash: result.txHash,
        applicationRequestId: input.requestId,
        resourceType: 'settlement_handoff',
        resourceId: input.handoffId,
        operation: 'create_trade',
        chainId: config.chainId,
        nonce: 7,
      }),
    );
    expect(
      dependencies.recordTransactionOutcome.recordPrepared.mock.invocationCallOrder[0],
    ).toBeLessThan(dependencies.provider.broadcastTransaction.mock.invocationCallOrder[0]);
    expect(dependencies.recordTransactionOutcome.markConfirmationPending).toHaveBeenCalledWith(
      result.txHash,
    );
    expect(dependencies.recordTransactionOutcome.markConfirmed).toHaveBeenCalledWith(
      result.txHash,
      expect.objectContaining({ blockNumber: '98765' }),
    );
  });

  test('never invokes the managed signer when durable nonce reservation fails', async () => {
    const dependencies = createFakeManagedSignerDependencies();
    dependencies.nonceReservationStore.reserve.mockRejectedValueOnce(
      new Error('nonce reservation conflict'),
    );
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          usdcAddress: config.usdcAddress,
          gaslessSignerCustodyMode: 'kms',
          gaslessManagedSignerUrl: 'https://signer.example.test',
        },
        dependencies,
      );

    await expect(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-reservation-conflict', 'f')),
    ).rejects.toThrow('nonce reservation conflict');
    expect(dependencies.nonceReservationStore.beginSigning).not.toHaveBeenCalled();
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
    expect(dependencies.provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  test.each([
    [
      'response_request_id',
      (response: FakeManagedSignerResponse) => ({ ...response, requestId: 'replayed-request' }),
    ],
    [
      'response_intent_hash',
      (response: FakeManagedSignerResponse) => ({
        ...response,
        intentHash: `0x${'0'.repeat(64)}`,
      }),
    ],
    [
      'response_signer',
      (response: FakeManagedSignerResponse) => ({ ...response, signerAddress: config.usdcAddress }),
    ],
    [
      'response_format',
      (response: FakeManagedSignerResponse) => ({ ...response, signedTransaction: 'not-hex' }),
    ],
  ] as const)(
    'managed custody rejects unbound signer response %s before broadcast',
    async (failureReason, mutateSignerResponse) => {
      const dependencies = createFakeManagedSignerDependencies({ mutateSignerResponse });
      const executor =
        gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
          {
            rpcUrl: config.rpcUrl,
            rpcFallbackUrls: config.rpcFallbackUrls,
            chainId: config.chainId,
            escrowAddress: config.escrowAddress,
            usdcAddress: config.usdcAddress,
            gaslessSignerCustodyMode: 'kms',
            gaslessManagedSignerUrl: 'https://signer.example.test',
            gaslessMinExecutorBalanceWei: 10n,
          },
          dependencies,
        );

      await expect(
        executor.executeCreateTrade(buildCreateTradeInput(`handoff-binding-${failureReason}`, 'b')),
      ).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        details: { failureReason },
      });
      expect(dependencies.provider.broadcastTransaction).not.toHaveBeenCalled();
      expect(dependencies.recordValidationEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'rejected', failureReason }),
        expect.any(Object),
      );
    },
  );

  test.each([
    ['recipient', (tx: FakeManagedSignerTransaction) => ({ ...tx, to: config.usdcAddress })],
    ['chainId', (tx: FakeManagedSignerTransaction) => ({ ...tx, chainId: 1 })],
    ['nonce', (tx: FakeManagedSignerTransaction) => ({ ...tx, nonce: tx.nonce + 1 })],
    ['value', (tx: FakeManagedSignerTransaction) => ({ ...tx, value: '1' })],
    ['calldata', (tx: FakeManagedSignerTransaction) => ({ ...tx, data: '0x12345678' })],
    ['gasLimit', (tx: FakeManagedSignerTransaction) => ({ ...tx, gasLimit: '210001' })],
    ['maxFeePerGas', (tx: FakeManagedSignerTransaction) => ({ ...tx, maxFeePerGasWei: '2' })],
    [
      'maxPriorityFeePerGas',
      (tx: FakeManagedSignerTransaction) => ({ ...tx, maxPriorityFeePerGasWei: '0' }),
    ],
    [
      'type',
      (tx: FakeManagedSignerTransaction): FakeManagedSignerTransaction => ({
        ...tx,
        type: 0,
        maxFeePerGasWei: undefined,
        maxPriorityFeePerGasWei: undefined,
        gasPriceWei: '1',
      }),
    ],
  ] as const)(
    'managed custody rejects a signer mutation of %s before broadcast',
    async (failureReason, mutateSignerTransaction) => {
      const dependencies = createFakeManagedSignerDependencies({ mutateSignerTransaction });
      const executor =
        gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
          {
            rpcUrl: config.rpcUrl,
            rpcFallbackUrls: config.rpcFallbackUrls,
            chainId: config.chainId,
            escrowAddress: config.escrowAddress,
            usdcAddress: config.usdcAddress,
            gaslessSignerCustodyMode: 'kms',
            gaslessManagedSignerUrl: 'https://signer.example.test',
            gaslessMaxGasLimit: 1_500_000n,
            gaslessMaxFeePerGasWei: 10n,
            gaslessMaxNativeCostWei: 10_000_000n,
            gaslessMinExecutorBalanceWei: 10n,
          },
          dependencies,
        );

      await expect(
        executor.executeCreateTrade(
          buildCreateTradeInput(`handoff-mutation-${failureReason}`, 'a'),
        ),
      ).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        details: { failureReason },
      });
      expect(dependencies.provider.broadcastTransaction).not.toHaveBeenCalled();
      expect(dependencies.recordValidationEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'rejected',
          failureReason,
          intentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        }),
        expect.any(Object),
      );
    },
  );

  test.each([
    ['open_dispute', 'openDisputeWithAuthorization'],
    ['cancel_locked_timeout', 'cancelLockedTradeAfterTimeoutWithAuthorization'],
    ['refund_in_transit_timeout', 'refundInTransitAfterTimeoutWithAuthorization'],
    ['finalize_after_dispute_window', 'finalizeAfterDisputeWindowWithAuthorization'],
    ['finalize_after_inspection_acceptance', 'finalizeAfterInspectionAcceptanceWithAuthorization'],
  ] as const)(
    'managed custody executor encodes %s with %s',
    async (action, expectedFunctionName) => {
      const dependencies = createFakeManagedSignerDependencies();
      const executor =
        gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
          {
            rpcUrl: config.rpcUrl,
            rpcFallbackUrls: config.rpcFallbackUrls,
            chainId: config.chainId,
            escrowAddress: config.escrowAddress,
            usdcAddress: config.usdcAddress,
            gaslessSignerCustodyMode: 'kms',
            gaslessManagedSignerUrl: 'https://signer.example.test',
            gaslessMaxGasLimit: 1_500_000n,
            gaslessMaxFeePerGasWei: 10n,
            gaslessMaxNativeCostWei: 10_000_000n,
            gaslessMinExecutorBalanceWei: 10n,
          },
          dependencies,
        );

      await executor.executeUserAction(buildUserActionInput(action, action));

      const signedRequest = dependencies.signerTransport.signTransaction.mock.calls[0][0];
      const escrowInterface = new Interface(AgroasysEscrow__factory.abi);
      expect(escrowInterface.parseTransaction({ data: signedRequest.transaction.data })?.name).toBe(
        expectedFunctionName,
      );
      expect(signedRequest.operation).toBe(action);
    },
  );

  test('managed custody executor retains an unknown outcome and never retries nonce drift', async () => {
    const dependencies = createFakeManagedSignerDependencies({
      broadcastFailures: [new Error('nonce too low')],
      nonceStart: 41,
    });
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          usdcAddress: config.usdcAddress,
          gaslessSignerCustodyMode: 'mpc',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMaxGasLimit: 1_500_000n,
          gaslessMaxFeePerGasWei: 10n,
          gaslessMaxNativeCostWei: 10_000_000n,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-retry', 'b')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless transaction broadcast outcome requires reconciliation',
      },
    );

    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledTimes(1);
    expect(dependencies.signerTransport.signTransaction.mock.calls[0][0].transaction.nonce).toBe(
      41,
    );
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(dependencies.recordTransactionOutcome.markBroadcastUnknown).toHaveBeenCalledWith(
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
      'Error',
    );
  });
});

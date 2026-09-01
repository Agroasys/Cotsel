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

    expect(result.txHash).toBe(
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    );
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
      }),
    );
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

  test('managed custody executor retries with a fresh nonce after nonce drift', async () => {
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

    await executor.executeCreateTrade(buildCreateTradeInput('handoff-retry', 'b'));

    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledTimes(2);
    expect(dependencies.signerTransport.signTransaction.mock.calls[0][0].transaction.nonce).toBe(
      41,
    );
    expect(dependencies.signerTransport.signTransaction.mock.calls[1][0].transaction.nonce).toBe(
      42,
    );
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });

  test('managed custody executor rejects low signer balance before signing', async () => {
    const dependencies = createFakeManagedSignerDependencies({ balanceWei: 1n });
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

    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-low', 'c')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless executor balance is below floor',
      },
    );
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
  });

  test('managed custody executor rejects fee-per-gas spend cap before signing', async () => {
    const dependencies = createFakeManagedSignerDependencies({ maxFeePerGasWei: 20n });
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
      executor.executeCreateTrade(buildCreateTradeInput('handoff-fee', 'd')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless relayer fee-per-gas cap exceeded',
      },
    );
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
  });

  test('managed custody executor fails visibly when a broadcast receipt is unavailable', async () => {
    const dependencies = createFakeManagedSignerDependencies({ receiptAvailable: false });
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
          gaslessReceiptTimeoutMs: 1000,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-timeout', 'e')),
      {
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless transaction receipt was not available',
      },
    );
    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledTimes(1);
  });

  test('managed executor surfaces transient RPC broadcast failure and recovers on next submission', async () => {
    const dependencies = createFakeManagedSignerDependencies({
      broadcastFailures: [new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8545')],
      nonceStart: 50,
    });
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

    // First broadcast fails with a connection error (not a nonce error),
    // so the executor does not retry internally — it surfaces the failure.
    await expect(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-rpc-fail', '1')),
    ).rejects.toThrow('ECONNREFUSED');

    // The failure consumed the mock error; next call succeeds, proving
    // the executor does not leave poisoned nonce or signer state.
    const recovered = await executor.executeCreateTrade(
      buildCreateTradeInput('handoff-rpc-recover', '2'),
    );
    expect(recovered.txHash).toBe(
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    );
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });
});

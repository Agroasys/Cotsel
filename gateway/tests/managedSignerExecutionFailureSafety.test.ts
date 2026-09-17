/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { testExports as gaslessSettlementExecutionTestExports } from '../src/core/gaslessSettlementExecutionService';
import {
  buildCreateTradeInput,
  config,
  createFakeManagedSignerDependencies,
} from './helpers/gaslessManagedSignerFixtures';

async function expectGatewayError(
  promise: Promise<unknown>,
  expected: { statusCode: number; code: string; message: string },
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toMatchObject({ statusCode: expected.statusCode, code: expected.code });
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe(expected.message);
}

function createExecutor(dependencies: ReturnType<typeof createFakeManagedSignerDependencies>) {
  return gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
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
      gaslessReceiptTimeoutMs: 1_000,
    },
    dependencies,
  );
}

describe('managed signer gasless execution failure safety', () => {
  test('derives a stable signing request identity for the same application request and nonce', async () => {
    const firstDependencies = createFakeManagedSignerDependencies({ nonceStart: 23 });
    const retryDependencies = createFakeManagedSignerDependencies({ nonceStart: 23 });
    const laterNonceDependencies = createFakeManagedSignerDependencies({ nonceStart: 24 });
    const input = buildCreateTradeInput('handoff-stable-signing-request', '9');

    await createExecutor(firstDependencies).executeCreateTrade(input);
    await createExecutor(retryDependencies).executeCreateTrade(input);
    await createExecutor(laterNonceDependencies).executeCreateTrade(input);

    const firstRequest = firstDependencies.signerTransport.signTransaction.mock.calls[0][0];
    const retryRequest = retryDependencies.signerTransport.signTransaction.mock.calls[0][0];
    const laterNonceRequest =
      laterNonceDependencies.signerTransport.signTransaction.mock.calls[0][0];
    expect(retryRequest.requestId).toBe(firstRequest.requestId);
    expect(retryRequest.intentHash).toBe(firstRequest.intentHash);
    expect(laterNonceRequest.requestId).not.toBe(firstRequest.requestId);
  });

  test('rejects low signer balance before signing', async () => {
    const dependencies = createFakeManagedSignerDependencies({ balanceWei: 1n });
    await expectGatewayError(
      createExecutor(dependencies).executeCreateTrade(buildCreateTradeInput('handoff-low', 'c')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless executor balance is below floor',
      },
    );
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
  });

  test('rejects fee-per-gas spend cap before signing', async () => {
    const dependencies = createFakeManagedSignerDependencies({ maxFeePerGasWei: 20n });
    await expectGatewayError(
      createExecutor(dependencies).executeCreateTrade(buildCreateTradeInput('handoff-fee', 'd')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless relayer fee-per-gas cap exceeded',
      },
    );
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
  });

  test('fails visibly when a broadcast receipt is unavailable', async () => {
    const dependencies = createFakeManagedSignerDependencies({ receiptAvailable: false });
    await expectGatewayError(
      createExecutor(dependencies).executeCreateTrade(
        buildCreateTradeInput('handoff-timeout', 'e'),
      ),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless transaction confirmation requires reconciliation',
      },
    );
    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledTimes(1);
    expect(dependencies.recordTransactionOutcome.markConfirmationPending).toHaveBeenCalledTimes(1);
    expect(dependencies.recordTransactionOutcome.markConfirmed).not.toHaveBeenCalled();
  });

  test('keeps one command unknown and permits a distinct later submission', async () => {
    const dependencies = createFakeManagedSignerDependencies({
      broadcastFailures: [new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8545')],
      nonceStart: 50,
    });
    const executor = createExecutor(dependencies);
    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-rpc-fail', '1')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless transaction broadcast outcome requires reconciliation',
      },
    );
    expect(dependencies.recordTransactionOutcome.markBroadcastUnknown).toHaveBeenCalledWith(
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
      'Error',
    );

    const recovered = await executor.executeCreateTrade(
      buildCreateTradeInput('handoff-rpc-recover', '2'),
    );
    expect(recovered.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });
});

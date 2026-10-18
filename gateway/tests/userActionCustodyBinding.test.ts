import { Wallet } from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { createManagedSignerGaslessSettlementExecutor } from '../src/core/gaslessManagedSignerExecutor';
import { createRawPrivateKeyGaslessSettlementExecutor } from '../src/core/gaslessRawPrivateKeyExecutor';
import { createGaslessPayloadHash } from '../src/core/gaslessRequestNormalization';
import type { SettlementHandoffRecord } from '../src/core/settlementStore';
import { createBoundUserActionFixture } from './helpers/boundUserActionFixture';
import {
  config,
  createFakeManagedSignerDependencies,
} from './helpers/gaslessManagedSignerFixtures';

jest.mock('@agroasys/sdk/rpc/failoverProvider', () => ({
  createManagedRpcProvider: jest.fn(),
}));

// Real binding/signature validation in both custody entry points; controlled funding port.
// Every valid request still reaches the unchanged hard denial, never signing or execution.
describe.each(['managed', 'raw'] as const)(
  '%s user-action immutable custody boundary',
  (custody) => {
    afterEach(() => jest.restoreAllMocks());
    async function setup(action: Parameters<typeof createBoundUserActionFixture>[0]) {
      const f = await createBoundUserActionFixture(action);
      const dependencies = createFakeManagedSignerDependencies();
      jest.mocked(createManagedRpcProvider).mockReturnValue(dependencies.provider as never);
      const {
        payloadHash: _hash,
        requestId: _request,
        sourceApiKeyId: _owner,
        ...hashable
      } = f.input;
      f.input.payloadHash = createGaslessPayloadHash(hashable);
      const handoff = {
        handoffId: f.input.handoffId,
        sourceApiKeyId: f.input.sourceApiKeyId,
        phase: 'gasless_user_action',
        settlementChannel: 'cotsel_escrow',
        tradeId: f.input.tradeId,
        externalReference: f.input.sourceOperationId,
        executionBinding: f.binding,
        executionStatus: 'pending',
      } as SettlementHandoffRecord;
      const load = jest.fn(async () => handoff);
      const funding = jest.fn(async () => {});
      const rawSign = jest.spyOn(Wallet.prototype, 'signTransaction');
      const rawSend = jest.spyOn(Wallet.prototype, 'sendTransaction');
      const executorConfig = {
        ...config,
        chainId: f.input.chainId,
        escrowAddress: f.input.contractAddress,
        usdcAddress: f.token,
        gaslessSignerCustodyMode: 'kms' as const,
        gaslessManagedSignerUrl: 'https://signer.example.test',
      };
      const executor =
        custody === 'managed'
          ? createManagedSignerGaslessSettlementExecutor(executorConfig, {
              ...dependencies,
              loadUserActionHandoff: load,
              verifyUserActionFunding: funding,
            })
          : createRawPrivateKeyGaslessSettlementExecutor(
              { ...executorConfig, gaslessExecutorPrivateKey: '0x' + '77'.repeat(32) },
              dependencies.recordTransactionOutcome,
              load,
              funding,
            );
      const assertNoSigning = () => {
        expect(rawSign).not.toHaveBeenCalled();
        expect(rawSend).not.toHaveBeenCalled();
        expect(dependencies.signerTransport.getSignerAddress).not.toHaveBeenCalled();
        expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
        expect(dependencies.nonceReservationStore.reserve).not.toHaveBeenCalled();
        expect(dependencies.provider.call).not.toHaveBeenCalled();
        expect(dependencies.provider.getTransactionCount).not.toHaveBeenCalled();
        expect(dependencies.provider.broadcastTransaction).not.toHaveBeenCalled();
        for (const record of Object.values(dependencies.recordTransactionOutcome))
          expect(record).not.toHaveBeenCalled();
      };
      return { ...f, executor, handoff, funding, assertNoSigning };
    }

    it.each([
      'finalize_after_inspection_acceptance',
      'cancel_locked_timeout',
      'refund_in_transit_timeout',
      'open_dispute',
      'finalize_after_dispute_window',
    ] as const)(
      'checks exact bound %s funding but keeps simulation and execution disabled',
      async (action) => {
        const f = await setup(action);
        await expect(f.executor.simulateUserAction(f.input)).rejects.toThrow(
          'settlement_client_upgrade_required',
        );
        await expect(f.executor.executeUserAction(f.input)).rejects.toThrow(
          'settlement_client_upgrade_required',
        );
        expect(f.funding).toHaveBeenCalledTimes(2);
        expect(f.funding).toHaveBeenCalledWith(f.binding);
        f.assertNoSigning();
      },
    );

    it.each([
      'actionPackageId',
      'sourceOperationId',
      'approvalScopeFingerprint',
      'tradeId',
      'sourceApiKeyId',
      'nonce',
      'signature',
    ] as const)(
      'rejects changed %s before original-funding verification or signer use',
      async (field) => {
        const f = await setup('finalize_after_inspection_acceptance');
        if (field === 'nonce') f.input.userAuthorization.nonce = '10';
        else if (field === 'signature')
          f.input.userAuthorization.signature = '0x' + '00'.repeat(65);
        else f.input[field] = 'different';
        await expect(f.executor.simulateUserAction(f.input)).rejects.toThrow();
        await expect(f.executor.executeUserAction(f.input)).rejects.toThrow();
        expect(f.funding).not.toHaveBeenCalled();
        f.assertNoSigning();
      },
    );

    it.each(['submitted', 'confirmed', 'failed'] as const)(
      'observes %s history instead of invoking funding verification or signing again',
      async (status) => {
        const f = await setup('cancel_locked_timeout');
        f.handoff.executionStatus = status;
        await expect(f.executor.executeUserAction(f.input)).rejects.toThrow('requires observation');
        expect(f.funding).not.toHaveBeenCalled();
        f.assertNoSigning();
      },
    );

    it('rejects contradictory funding evidence before any capacity or signer use', async () => {
      const f = await setup('refund_in_transit_timeout');
      f.funding.mockRejectedValue(new Error('controlled noncanonical original funding'));
      await expect(f.executor.executeUserAction(f.input)).rejects.toThrow(
        'noncanonical original funding',
      );
      expect(f.funding).toHaveBeenCalledTimes(1);
      f.assertNoSigning();
    });
  },
);

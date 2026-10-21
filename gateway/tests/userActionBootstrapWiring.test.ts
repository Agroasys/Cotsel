/** SPDX-License-Identifier: Apache-2.0 */
import { createConfiguredGaslessSettlementService } from '../src/core/gaslessSettlementServiceFactory';
import { createOwnedUserActionAdapter } from '../src/core/userActionEngine/adapter';
import {
  resolveUserActionRetirementDependency,
  USER_ACTION_RETIREMENT_PATH,
} from '../src/config/userActionRetirement';
import { config } from './helpers/gaslessManagedSignerFixtures';
import proofFixture from './fixtures/lifecycle-retirement-proof.json';
jest.mock('../src/core/gaslessExecutorFactory', () => ({
  createEthersGaslessSettlementExecutor: jest.fn(() => ({})),
}));
jest.mock('../src/core/userActionEngine/adapter', () => ({
  createOwnedUserActionAdapter: jest.fn(() => ({
    bindRuntime: jest.fn(),
    isCommittedReplay: jest.fn(async () => false),
  })),
}));
describe('Gateway owning factory retirement dependency wiring', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });
  test.each([true, false])(
    'complete dependency=%s is passed to the owned adapter without granting public capability',
    async (complete) => {
      const c = {
        ...config,
        userActionRetirementEvidenceUrl: complete
          ? 'https://backend.example.test' + USER_ACTION_RETIREMENT_PATH
          : undefined,
        userActionRetirementOwningServiceId: proofFixture.scope.ownerServiceId,
        settlementCallbackApiKey: 'fixture-callback-key',
        settlementCallbackApiSecret: 'fixture-secret',
      };
      // Same pure resolution and actual factory invoked by Gateway bootstrap; no provider is called by construction.
      const dependency = resolveUserActionRetirementDependency(c);
      const service = createConfiguredGaslessSettlementService(
        c,
        {} as never,
        {} as never,
        { getHandoff: jest.fn() } as never,
        jest.fn(),
        {} as never,
        dependency,
      );
      expect(service).not.toBeNull();
      const calls = jest.mocked(createOwnedUserActionAdapter).mock.calls;
      const ports = calls[calls.length - 1][0];
      if (complete) {
        global.fetch = jest.fn(async () => new Response(JSON.stringify(proofFixture.response)));
        expect(await ports.verifyRetirement!(proofFixture.scope)).toEqual(
          proofFixture.response.data,
        );
        expect(String(jest.mocked(fetch).mock.calls[0][0])).toBe(c.userActionRetirementEvidenceUrl);
      } else expect(ports.verifyRetirement).toBeUndefined();
      await expect(service!.executeUserAction({} as never)).rejects.toThrow(
        'settlement_client_upgrade_required',
      );
    },
  );
});

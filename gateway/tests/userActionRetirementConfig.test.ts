/** SPDX-License-Identifier: Apache-2.0 */
import {
  resolveUserActionRetirementDependency,
  USER_ACTION_RETIREMENT_PATH,
} from '../src/config/userActionRetirement';
import { loadConfigModule, withEnv } from './helpers/gatewayConfigTestHarness';
import { requireReviewedUserActionCapability } from '../src/core/gaslessExecutionValidation';
const complete = {
  userActionRetirementEvidenceUrl: 'https://backend.example.test' + USER_ACTION_RETIREMENT_PATH,
  userActionRetirementOwningServiceId: 'owner',
  settlementCallbackApiKey: 'fixture-callback-key',
  settlementCallbackApiSecret: 'fixture-secret',
};
describe('explicit retirement dependency configuration (no activation authority)', () => {
  test('loads only explicit pair and existing credentials; does not infer callback URL or service identity', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_USER_ACTION_RETIREMENT_EVIDENCE_URL: complete.userActionRetirementEvidenceUrl,
        GATEWAY_USER_ACTION_RETIREMENT_OWNING_SERVICE_ID: 'owner',
        GATEWAY_SETTLEMENT_CALLBACK_ENABLED: 'false',
        GATEWAY_SETTLEMENT_CALLBACK_API_KEY: complete.settlementCallbackApiKey,
        GATEWAY_SETTLEMENT_CALLBACK_API_SECRET: complete.settlementCallbackApiSecret,
      },
      () => {
        const config = loadConfigModule().loadConfig();
        expect(resolveUserActionRetirementDependency(config)).toEqual({
          url: complete.userActionRetirementEvidenceUrl,
          owningServiceId: 'owner',
        });
        expect(() => requireReviewedUserActionCapability()).toThrow(
          'settlement_client_upgrade_required',
        );
      },
    );
  });
  test.each(Object.keys(complete) as Array<keyof typeof complete>)(
    'missing %s denies this dependency only',
    (key) => {
      expect(
        resolveUserActionRetirementDependency({ ...complete, [key]: undefined }),
      ).toBeUndefined();
    },
  );
  test.each([
    'http://backend.example.test' + USER_ACTION_RETIREMENT_PATH,
    'https://user:PRIVATE@backend.example.test' + USER_ACTION_RETIREMENT_PATH,
    'https://backend.example.test/settlement-handoffs/cotsel/lifecycle-action-retirement-evidence',
    'https://backend.example.test/other' + USER_ACTION_RETIREMENT_PATH,
    'https://backend.example.test' + USER_ACTION_RETIREMENT_PATH + '?owner=foreign',
    'https://backend.example.test' + USER_ACTION_RETIREMENT_PATH + '#fragment',
    'PRIVATE_NOT_A_URL',
  ])(
    'malformed complete dependency remains unavailable without disabling unrelated configuration',
    (url) => {
      withEnv(
        {
          GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
          GATEWAY_USER_ACTION_RETIREMENT_EVIDENCE_URL: url,
          GATEWAY_USER_ACTION_RETIREMENT_OWNING_SERVICE_ID: 'owner',
        },
        () => {
          const config = loadConfigModule().loadConfig();
          expect(config.port).toBe(3600);
          expect(
            resolveUserActionRetirementDependency({
              ...config,
              settlementCallbackApiKey: 'key',
              settlementCallbackApiSecret: 'secret',
            }),
          ).toBeUndefined();
        },
      );
    },
  );
  test.each(['', 'owner with space', 'x'.repeat(129)])(
    'rejects invalid explicit owner',
    (owner) => {
      expect(
        resolveUserActionRetirementDependency({
          ...complete,
          userActionRetirementOwningServiceId: owner,
        }),
      ).toBeUndefined();
    },
  );
  test('absent pair cannot derive authority from existing callback settings', () => {
    expect(
      resolveUserActionRetirementDependency({
        settlementCallbackApiKey: 'key',
        settlementCallbackApiSecret: 'secret',
      }),
    ).toBeUndefined();
  });
});

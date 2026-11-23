/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { loadConfigModule, withEnv } from './helpers/gatewayConfigTestHarness';

const RUNTIME = {
  GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
  GATEWAY_RPC_URL: undefined,
  GATEWAY_CHAIN_ID: undefined,
};

describe('gateway step-up configuration (Cotsel#946)', () => {
  it('defaults to a 300 second hardware WebAuthn step-up, enforced', () => {
    withEnv(RUNTIME, () => {
      const config = loadConfigModule().loadConfig();
      expect(config.stepUpMaxAgeSeconds).toBe(300);
      expect(config.stepUpAcceptedStrengths).toEqual(['hardware_webauthn']);
      expect(config.stepUpEnforcement).toBe('enforce');
    });
  });

  it('accepts an explicit policy', () => {
    withEnv(
      {
        ...RUNTIME,
        GATEWAY_STEP_UP_MAX_AGE_SECONDS: '600',
        GATEWAY_STEP_UP_ACCEPTED_STRENGTHS: 'hardware_webauthn, auth0_mfa',
        GATEWAY_STEP_UP_ENFORCEMENT: 'record',
      },
      () => {
        const config = loadConfigModule().loadConfig();
        expect(config.stepUpMaxAgeSeconds).toBe(600);
        expect(config.stepUpAcceptedStrengths).toEqual(['hardware_webauthn', 'auth0_mfa']);
        expect(config.stepUpEnforcement).toBe('record');
      },
    );
  });

  it.each([
    [{ GATEWAY_STEP_UP_MAX_AGE_SECONDS: '30' }, /GATEWAY_STEP_UP_MAX_AGE_SECONDS/],
    [{ GATEWAY_STEP_UP_MAX_AGE_SECONDS: '7200' }, /GATEWAY_STEP_UP_MAX_AGE_SECONDS/],
    [{ GATEWAY_STEP_UP_ACCEPTED_STRENGTHS: 'sms' }, /GATEWAY_STEP_UP_ACCEPTED_STRENGTHS/],
    [{ GATEWAY_STEP_UP_ACCEPTED_STRENGTHS: ' , ' }, /GATEWAY_STEP_UP_ACCEPTED_STRENGTHS/],
    [{ GATEWAY_STEP_UP_ENFORCEMENT: 'off' }, /GATEWAY_STEP_UP_ENFORCEMENT/],
  ])('rejects an invalid policy %p', (overrides, message) => {
    withEnv({ ...RUNTIME, ...overrides }, () => {
      expect(() => loadConfigModule().loadConfig()).toThrow(message);
    });
  });
});

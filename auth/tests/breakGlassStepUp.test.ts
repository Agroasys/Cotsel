/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Break-glass always requires a fresh step-up (Cotsel#946), enforced by Cotsel
 * itself on the HMAC-authenticated grant, not only behind Agroasys's proxy.
 */
import type { Request, Response } from 'express';
import { AdminController } from '../src/api/adminController';
import type { AdminService } from '../src/core/adminService';
import { DEFAULT_BREAK_GLASS_STEP_UP_POLICY } from '../src/core/breakGlassStepUp';
import { freshOperatorAuthentication } from './helpers/operatorAuthentication';

const NOW = 1_800_000_000;

function grant(operatorAuthentication: unknown) {
  const grantBreakGlass = jest.fn().mockResolvedValue({
    accountId: 'acct-admin',
    role: 'admin',
    breakGlassRole: 'admin',
    breakGlassExpiresAt: new Date((NOW + 300) * 1000),
  });
  const controller = new AdminController({ grantBreakGlass } as unknown as AdminService, {
    policy: DEFAULT_BREAK_GLASS_STEP_UP_POLICY,
    nowSeconds: () => NOW,
  });
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  const request = {
    body: {
      accountId: 'acct-admin',
      ttlSeconds: 300,
      baseRole: 'buyer',
      reason: 'INC-946 break-glass step-up proof',
      operatorAuthentication,
    },
    serviceAuth: {
      apiKeyId: 'admin-control-key',
      humanPrincipalId: 'agroasys-user:operator',
      scheme: 'api_key',
    },
  } as unknown as Request;
  return {
    run: () => controller.grantBreakGlass(request as never, response),
    grantBreakGlass,
    response,
  };
}

const claims = (ageSeconds: number, authStrength = 'hardware_webauthn') => ({
  authTime: NOW - ageSeconds,
  authMethod: 'webauthn',
  authStrength,
});

describe('break-glass grant step-up (Cotsel#946)', () => {
  it('grants with a hardware step-up inside the window', async () => {
    const { run, grantBreakGlass, response } = grant(claims(300));
    await run();
    expect(response.status).toHaveBeenCalledWith(201);
    expect(grantBreakGlass).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no operator authentication', undefined],
    ['a step-up one second past the window', claims(301)],
    ['a software-only WebAuthn step-up', claims(10, 'webauthn')],
    ['a password authentication', claims(10, 'password')],
    ['no authentication time', { authMethod: 'webauthn', authStrength: 'hardware_webauthn' }],
  ])('refuses %s with 403 StepUpRequired and grants nothing', async (_label, value) => {
    const { run, grantBreakGlass, response } = grant(value);
    await run();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'StepUpRequired' }),
    );
    expect(grantBreakGlass).not.toHaveBeenCalled();
  });

  it('rejects a malformed claim as a bad request rather than ignoring it', async () => {
    const { run, grantBreakGlass, response } = grant({ ...claims(10), authStrength: 'magic' });
    await run();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(grantBreakGlass).not.toHaveBeenCalled();
  });

  it('the shared helper produces claims the default policy accepts', async () => {
    const { run, response } = grant({ ...freshOperatorAuthentication(), authTime: NOW });
    await run();
    expect(response.status).toHaveBeenCalledWith(201);
  });
});

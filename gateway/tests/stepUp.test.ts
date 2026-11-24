/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cotsel#946: privileged mutations require a recent, strong upstream step-up.
 */
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_STEP_UP_POLICY, resolveStepUpPolicy } from '../src/config/gatewayConfig';
import type { GatewayConfig } from '../src/config/env';
import type { AuditLogEntry } from '../src/core/auditLogStore';
import type { AuthSession } from '../src/core/authSessionClient';
import { GatewayError } from '../src/errors';
import { evaluateStepUp, requireRecentStepUp } from '../src/middleware/stepUp';
import { baseTestGatewayConfig } from './support/testConfig';

const NOW = 1_800_000_000;
const policy = {
  maxAgeSeconds: 300,
  acceptedStrengths: ['hardware_webauthn'],
  enforcement: 'enforce' as const,
};
const assurance = (ageSeconds: number, strength: string | null = 'hardware_webauthn') => ({
  authTime: NOW - ageSeconds,
  method: 'webauthn',
  strength,
});

describe('evaluateStepUp', () => {
  it('accepts a step-up exactly at the maximum age and refuses one second later', () => {
    expect(evaluateStepUp(assurance(300), policy, NOW)).toEqual({
      fresh: true,
      refusal: null,
      ageSeconds: 300,
    });
    expect(evaluateStepUp(assurance(301), policy, NOW)).toEqual({
      fresh: false,
      refusal: 'stale',
      ageSeconds: 301,
    });
  });

  it('refuses a session without assurance, from an older auth image or without a step-up', () => {
    expect(evaluateStepUp(undefined, policy, NOW).refusal).toBe('no_assurance');
    expect(
      evaluateStepUp({ authTime: null, method: null, strength: null }, policy, NOW).refusal,
    ).toBe('no_assurance');
  });

  it('refuses a recent but weaker authentication', () => {
    expect(evaluateStepUp(assurance(10, 'password'), policy, NOW).refusal).toBe(
      'insufficient_strength',
    );
    expect(evaluateStepUp(assurance(10, null), policy, NOW).refusal).toBe('insufficient_strength');
  });

  it('treats an authTime slightly ahead of the clock as age zero', () => {
    expect(evaluateStepUp(assurance(-30), policy, NOW)).toEqual({
      fresh: true,
      refusal: null,
      ageSeconds: 0,
    });
  });

  it('defaults to 300 seconds, hardware WebAuthn and enforcement', () => {
    expect(resolveStepUpPolicy(baseTestGatewayConfig as GatewayConfig)).toEqual(
      DEFAULT_STEP_UP_POLICY,
    );
  });
});

describe('requireRecentStepUp', () => {
  function run(
    authentication: AuthSession['authentication'],
    overrides: Partial<GatewayConfig> = {},
    append: (entry: AuditLogEntry) => Promise<void> = async () => undefined,
  ) {
    const audit: AuditLogEntry[] = [];
    const middleware = requireRecentStepUp(
      { ...(baseTestGatewayConfig as GatewayConfig), ...overrides },
      {
        nowSeconds: () => NOW,
        auditLogStore: {
          append: async (entry) => {
            await append(entry);
            audit.push(entry);
          },
        },
      },
    );
    const req = {
      originalUrl: '/api/dashboard-gateway/v1/governance/pause/prepare',
      method: 'POST',
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: 0 },
      gatewayPrincipal: {
        session: {
          userId: 'uid-admin',
          walletAddress: '0x00000000000000000000000000000000000000aa',
          role: 'admin',
          authentication,
        },
      },
    } as unknown as Request;
    return new Promise<{ error: unknown; req: Request; audit: AuditLogEntry[] }>((resolve) => {
      void middleware(
        req,
        {} as Response,
        ((error?: unknown) => resolve({ error, req, audit })) as NextFunction,
      );
    });
  }

  it('lets a fresh step-up through and records it with the request id', async () => {
    const { error, req, audit } = await run(assurance(60));
    expect(error).toBeUndefined();
    expect(req.stepUpEvidence).toMatchObject({ authTime: NOW - 60, ageSeconds: 60 });
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: 'gateway.step_up_verified',
        requestId: 'req-1',
        actorUserId: 'uid-admin',
        status: 'accepted',
        metadata: {
          stepUp: expect.objectContaining({
            authTime: NOW - 60,
            method: 'webauthn',
            strength: 'hardware_webauthn',
            ageSeconds: 60,
            refusal: null,
          }),
        },
      }),
    ]);
  });

  it('refuses a stale step-up with a typed step_up_required error and audits the refusal', async () => {
    const { error, audit } = await run(assurance(301));
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      details: {
        reason: 'step_up_required',
        refusal: 'stale',
        maxAgeSeconds: 300,
        acceptedStrengths: ['hardware_webauthn'],
        authenticatedAt: new Date((NOW - 301) * 1000).toISOString(),
      },
    });
    expect(audit[0]).toMatchObject({ eventType: 'gateway.step_up_required', status: 'rejected' });
  });

  it('in record mode allows a stale step-up but audits it as stale', async () => {
    const { error, req, audit } = await run(assurance(900), { stepUpEnforcement: 'record' });
    expect(error).toBeUndefined();
    expect(req.stepUpEvidence?.enforcement).toBe('record');
    expect(audit[0]).toMatchObject({ eventType: 'gateway.step_up_stale', status: 'allowed' });
  });

  it('honours a configured maximum age and accepted strengths', async () => {
    const { error } = await run(assurance(500, 'auth0_mfa'), {
      stepUpMaxAgeSeconds: 600,
      stepUpAcceptedStrengths: ['hardware_webauthn', 'auth0_mfa'],
    });
    expect(error).toBeUndefined();
  });

  it('does not let a privileged action through when its audit record cannot be written', async () => {
    const { error } = await run(assurance(10), {}, async () => {
      throw new Error('database unavailable');
    });
    expect(error).toMatchObject({ statusCode: 503, code: 'UPSTREAM_UNAVAILABLE' });
  });
});

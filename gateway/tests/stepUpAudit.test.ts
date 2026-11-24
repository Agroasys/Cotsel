/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { runWithStepUpEvidence, withStepUpEvidence } from '../src/core/stepUpAudit';
import { requireRecentStepUp } from '../src/middleware/stepUp';
import { freshStepUp } from './support/stepUp';
import { baseTestGatewayConfig } from './support/testConfig';

const EVIDENCE = {
  authTime: 1_700_000_000,
  method: 'webauthn',
  strength: 'hardware_webauthn',
  ageSeconds: 4,
  maxAgeSeconds: 300,
  enforcement: 'enforce' as const,
};

describe('step-up evidence on action audit entries (Cotsel#946)', () => {
  it('is added only inside a guarded request, and never overwrites', async () => {
    expect(withStepUpEvidence({ a: 1 })).toEqual({ a: 1 });
    expect(withStepUpEvidence(undefined)).toBeUndefined();
    await runWithStepUpEvidence(EVIDENCE, async () => {
      // Survives the awaits an idempotency store or a database call makes.
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(withStepUpEvidence({ a: 1 })).toEqual({ a: 1, stepUp: EVIDENCE });
      expect(withStepUpEvidence(undefined)).toEqual({ stepUp: EVIDENCE });
      expect(withStepUpEvidence({ stepUp: 'own' })).toEqual({ stepUp: 'own' });
    });
  });

  it('flows from the real guard to an audit row the handler writes', async () => {
    const store = createInMemoryAuditLogStore();
    const guard = requireRecentStepUp({ ...baseTestGatewayConfig }, {});
    const req = {
      gatewayPrincipal: { session: { userId: 'uid-admin', authentication: freshStepUp(10) } },
      requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: 0 },
      originalUrl: '/x',
      path: '/x',
      method: 'POST',
    } as unknown as Request;
    await new Promise<void>((resolve, reject) => {
      const next: NextFunction = (error?: unknown) => {
        if (error) return reject(error);
        void (async () => {
          await new Promise((r) => setTimeout(r, 1));
          await store.append({
            eventType: 'treasury.action',
            route: '/x',
            method: 'POST',
            requestId: 'req-1',
            status: 'success',
            metadata: { treasuryPath: '/p' },
          });
          resolve();
        })();
      };
      void guard(req, {} as Response, next);
    });
    expect(store.entries[0].metadata).toEqual({
      treasuryPath: '/p',
      stepUp: expect.objectContaining({ strength: 'hardware_webauthn', enforcement: 'enforce' }),
    });
  });
});

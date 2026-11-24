/** SPDX-License-Identifier: Apache-2.0 */
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { gatewayRateLimitPolicy } from '../src/httpSecurity';
import { startGovernanceEvidenceServer } from './support/governanceEvidenceHarness';

test('real freeze review and preparation routes share the gateway write budget', async () => {
  const limiter = await createHttpRateLimiter({
    enabled: true,
    nodeEnv: 'test',
    keyPrefix: 'freeze-route-budget',
    classifyRoute: gatewayRateLimitPolicy,
    nowSeconds: () => 1_000,
  });
  const { server, baseUrl } = await startGovernanceEvidenceServer(
    {
      hasActiveProposal: false,
      approvalCount: 0,
      executed: false,
      scope: 'GLOBAL',
      tradeId: '0',
      incidentRef: null,
    },
    undefined,
    undefined,
    limiter.middleware,
  );
  const call = (action: string) =>
    fetch(`${baseUrl}/governance/freeze-requests/${'a'.repeat(64)}/${action}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sess-admin',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ signerWallet: '0x00000000000000000000000000000000000000aa' }),
    });
  try {
    // Both real handlers reach the configured-dependency refusal below budget.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await call(attempt % 2 === 0 ? 'review' : 'prepare')).status).toBe(503);
    }
    for (const action of ['review', 'prepare']) {
      const blocked = await call(action);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('10');
      expect(blocked.headers.get('RateLimit-Remaining')).toBe('0');
      expect(await blocked.json()).toMatchObject({
        error: 'Rate limit exceeded. Retry after the provided delay.',
      });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await limiter.close();
  }
});

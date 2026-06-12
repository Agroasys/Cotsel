/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

function readGatewaySource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
}

function routeBlock(source: string, route: string): string {
  const marker = `'${route}'`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextRoute = source.indexOf('router.post(', start + marker.length);
  return source.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

describe('privileged signer route coverage', () => {
  test('treasury signer-required routes call the centralized signer policy helper', () => {
    const source = readGatewaySource('src/routes/treasury.ts');
    const directSignerRoutes = [
      '/treasury/accounting-periods/:periodId/request-close',
      '/treasury/accounting-periods/:periodId/close',
      '/treasury/sweep-batches/:batchId/request-approval',
      '/treasury/sweep-batches/:batchId/approve',
      '/treasury/sweep-batches/:batchId/match-execution',
      '/treasury/sweep-batches/:batchId/close',
      '/treasury/entries/:entryId/realizations',
    ];
    const sharedHandoffRoutes = [
      '/treasury/sweep-batches/:batchId/external-handoff',
      '/treasury/sweep-batches/:batchId/partner-handoff',
    ];

    expect(source).toContain('const assertAuthorizedTreasurySigner');
    expect(source).toMatch(
      /return requireAuthorizedSignerBinding\(\s*req\.gatewayPrincipal,\s*options\.config,\s*actionClass/,
    );

    for (const route of directSignerRoutes) {
      const block = routeBlock(source, route);
      expect(block).toContain('signerPolicy: {');
      expect(block).toContain('required: true');
      expect(block).toContain('binding: assertAuthorizedTreasurySigner(');
    }

    const sharedHandler = source.slice(
      source.indexOf('const recordExternalHandoff'),
      source.indexOf("router.post(\n    '/treasury/sweep-batches/:batchId/external-handoff'"),
    );
    expect(sharedHandler).toContain('signerPolicy: {');
    expect(sharedHandler).toContain('required: true');
    expect(sharedHandler).toContain("actionClass: 'treasury_execute'");
    expect(sharedHandler).toContain('binding: assertAuthorizedTreasurySigner(');

    for (const route of sharedHandoffRoutes) {
      const block = routeBlock(source, route);
      expect(block).toContain('...requireTreasuryExecuteMatch');
      expect(block).toContain('recordExternalHandoff');
    }
  });
});

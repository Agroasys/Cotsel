/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';

import { evaluateReadiness, type ReadinessCheck } from '@agroasys/shared-edge';
import type { DependencyStatus } from './routes/system';
import type { GaslessRelayerReadinessSnapshot } from './core/gaslessExecutionTypes';

type ReadinessChecks = {
  auth: (requestId: string) => Promise<void>;
  database: () => Promise<void>;
  governance: () => Promise<void>;
  indexer: () => Promise<void>;
  /** Present only when gasless execution is enabled: the gateway's local queue and policy state. */
  gaslessRelayer?: () => GaslessRelayerReadinessSnapshot;
  /** Present only when gasless signing is delegated to the standalone relayer (KMS custody). */
  gaslessRelayerService?: () => Promise<void>;
  timeoutMs?: number;
};

/**
 * A blocked relayer cannot accept new gasless commitments, so a gasless-enabled gateway is not
 * ready. A deliberate pause is an operator control, not a dependency failure.
 */
export function assertGaslessRelayerServing(snapshot: GaslessRelayerReadinessSnapshot): void {
  if (snapshot.state === 'blocked') {
    throw new Error('Gasless relayer is blocked');
  }
}

export function loadPackageVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../package.json'),
    path.resolve(process.cwd(), 'gateway/package.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
    if (parsed.version) return parsed.version;
  }

  return '0.1.0';
}

export function createReadinessCheck(checks: ReadinessChecks) {
  return async (): Promise<DependencyStatus[]> => {
    const requestId = `readyz-${Date.now()}`;
    const dependencyChecks: ReadinessCheck[] = [
      { name: 'postgres', check: checks.database },
      { name: 'auth-service', check: () => checks.auth(requestId) },
      { name: 'chain-rpc', check: checks.governance },
      { name: 'indexer-graphql', check: checks.indexer },
    ];
    if (checks.gaslessRelayerService) {
      dependencyChecks.push({ name: 'gasless-relayer', check: checks.gaslessRelayerService });
    }
    const gaslessRelayer = checks.gaslessRelayer;
    if (gaslessRelayer) {
      dependencyChecks.push({
        name: 'gasless-relayer-policy',
        check: async () => assertGaslessRelayerServing(gaslessRelayer()),
      });
    }

    const { dependencies } = await evaluateReadiness(dependencyChecks, {
      defaultTimeoutMs: checks.timeoutMs,
    });
    return dependencies;
  };
}

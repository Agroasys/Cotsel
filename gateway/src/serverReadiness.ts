/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';

type ReadinessDependency = {
  name: string;
  status: 'ok' | 'degraded' | 'unavailable';
  detail?: string;
};

type ReadinessChecks = {
  auth: (requestId: string) => Promise<void>;
  database: () => Promise<void>;
  governance: () => Promise<void>;
  indexer: () => Promise<void>;
};

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
  return async (): Promise<ReadinessDependency[]> => {
    const requestId = `readyz-${Date.now()}`;
    const dependencies: ReadinessDependency[] = [];
    const run = async (
      name: string,
      check: () => Promise<void>,
      fallbackDetail: string,
    ): Promise<void> => {
      try {
        await check();
        dependencies.push({ name, status: 'ok' });
      } catch (error) {
        dependencies.push({
          name,
          status: 'unavailable',
          detail: error instanceof Error ? error.message : fallbackDetail,
        });
      }
    };

    await run('postgres', checks.database, 'Database connection failed');
    await run('auth-service', () => checks.auth(requestId), 'Auth service unavailable');
    await run('chain-rpc', checks.governance, 'Chain RPC unavailable');
    await run('indexer-graphql', checks.indexer, 'Indexer GraphQL unavailable');
    return dependencies;
  };
}

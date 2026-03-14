/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';
import { loadOpenApiSpec } from '../src/openapi/spec';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

describe('loadOpenApiSpec', () => {
  const existsSyncMock = jest.mocked(fs.existsSync);
  const readFileSyncMock = jest.mocked(fs.readFileSync);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('prefers the checked-in source spec over stale dist output', () => {
    const repoSpecPath = path.resolve(process.cwd(), 'docs/api/cotsel-dashboard-gateway.openapi.yml');
    const distSpecPath = path.resolve(process.cwd(), 'gateway/dist/openapi/cotsel-dashboard-gateway.openapi.yml');

    existsSyncMock.mockImplementation((candidate) => candidate === repoSpecPath || candidate === distSpecPath);
    readFileSyncMock.mockImplementation((candidate) => {
      if (candidate === repoSpecPath) {
        return 'openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas:\n    OperationsSummaryResponse:\n      type: object\n';
      }

      if (candidate === distSpecPath) {
        return 'openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas: {}\n';
      }

      throw new Error(`Unexpected spec path: ${candidate.toString()}`);
    });

    const spec = loadOpenApiSpec();

    expect(spec.components?.schemas?.OperationsSummaryResponse).toBeDefined();
    expect(readFileSyncMock).toHaveBeenCalledWith(repoSpecPath, 'utf8');
    expect(readFileSyncMock).not.toHaveBeenCalledWith(distSpecPath, 'utf8');
  });
});

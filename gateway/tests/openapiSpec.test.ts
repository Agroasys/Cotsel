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

  test('prefers the generated workspace bundle over stale dist output', () => {
    const generatedSpecPath = path.resolve(
      process.cwd(),
      'gateway/.generated/openapi/cotsel-dashboard-gateway.openapi.yml',
    );
    const distSpecPath = path.resolve(
      process.cwd(),
      'gateway/dist/openapi/cotsel-dashboard-gateway.openapi.yml',
    );

    existsSyncMock.mockImplementation(
      (candidate) => candidate === generatedSpecPath || candidate === distSpecPath,
    );
    readFileSyncMock.mockImplementation((candidate) => {
      if (candidate === generatedSpecPath) {
        return 'openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas:\n    OperationsSummaryResponse:\n      type: object\n';
      }

      if (candidate === distSpecPath) {
        return 'openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas: {}\n';
      }

      throw new Error(`Unexpected spec path: ${candidate.toString()}`);
    });

    const spec = loadOpenApiSpec();

    expect(spec.components?.schemas?.OperationsSummaryResponse).toBeDefined();
    expect(readFileSyncMock).toHaveBeenCalledWith(generatedSpecPath, 'utf8');
    expect(readFileSyncMock).not.toHaveBeenCalledWith(distSpecPath, 'utf8');
  });
});

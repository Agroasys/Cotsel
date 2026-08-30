/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadOpenApiSpec } from '../src/openapi/spec';

describe('dashboard gateway OpenAPI bundle', () => {
  test('is generated from the complete modular source', () => {
    const repositoryRoot = path.resolve(__dirname, '../..');
    const scriptPath = path.join(
      repositoryRoot,
      'gateway/scripts/openapi/dashboard-gateway-spec.mjs',
    );

    expect(() =>
      execFileSync(process.execPath, [scriptPath, '--check'], {
        cwd: repositoryRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();

    const index = fs.readFileSync(
      path.join(repositoryRoot, 'docs/api/cotsel-dashboard-gateway.openapi.yml'),
      'utf8',
    );
    expect(index.startsWith('# MODULAR OPENAPI INDEX.')).toBe(true);
    expect(index.split('\n').length).toBeLessThanOrEqual(500);

    const bundle = fs.readFileSync(
      path.join(repositoryRoot, 'gateway/.generated/openapi/cotsel-dashboard-gateway.openapi.yml'),
      'utf8',
    );
    expect(bundle.startsWith('# GENERATED FILE. DO NOT EDIT DIRECTLY.')).toBe(true);

    const spec = loadOpenApiSpec();
    expect(Object.keys(spec.paths)).toHaveLength(62);
    expect(Object.keys(spec.components?.schemas ?? {})).toHaveLength(212);
  });
});

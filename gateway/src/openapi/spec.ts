/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface OpenApiSpec {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}

export function loadOpenApiSpec(): OpenApiSpec {
  const candidates = [
    path.resolve(__dirname, './web3layer-dashboard-gateway.openapi.yml'),
    path.resolve(__dirname, '../../dist/openapi/web3layer-dashboard-gateway.openapi.yml'),
    path.resolve(__dirname, '../../../docs/api/web3layer-dashboard-gateway.openapi.yml'),
    path.resolve(process.cwd(), 'docs/api/web3layer-dashboard-gateway.openapi.yml'),
  ];

  const specPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!specPath) {
    throw new Error('Unable to locate dashboard gateway OpenAPI spec');
  }

  const parsed = yaml.load(fs.readFileSync(specPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Dashboard gateway OpenAPI spec is invalid');
  }

  return parsed as OpenApiSpec;
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import Ajv, { AnySchema, ValidateFunction } from 'ajv';
import { OpenApiSpec } from './spec';

function resolvePointer(spec: OpenApiSpec, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported OpenAPI reference: ${ref}`);
  }

  const segments = ref.slice(2).split('/');
  let current: unknown = spec;

  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
      throw new Error(`Unable to resolve OpenAPI reference: ${ref}`);
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function dereferenceSchema(spec: OpenApiSpec, schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => dereferenceSchema(spec, entry));
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const asRecord = schema as Record<string, unknown>;
  if (typeof asRecord.$ref === 'string') {
    return dereferenceSchema(spec, resolvePointer(spec, asRecord.$ref));
  }

  return Object.fromEntries(
    Object.entries(asRecord).map(([key, value]) => [key, dereferenceSchema(spec, value)]),
  );
}

export function createSchemaValidator(spec: OpenApiSpec, ref: string): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
  const schema = dereferenceSchema(spec, resolvePointer(spec, ref));
  return ajv.compile(schema as AnySchema);
}

export function hasOperation(spec: OpenApiSpec, method: string, path: string): boolean {
  const operation = spec.paths?.[path]?.[method.toLowerCase()];
  return Boolean(operation);
}

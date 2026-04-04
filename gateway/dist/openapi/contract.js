"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSchemaValidator = createSchemaValidator;
exports.hasOperation = hasOperation;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const ajv_1 = __importDefault(require("ajv"));
function resolvePointer(spec, ref) {
    if (!ref.startsWith('#/')) {
        throw new Error(`Unsupported OpenAPI reference: ${ref}`);
    }
    const segments = ref.slice(2).split('/');
    let current = spec;
    for (const segment of segments) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
            throw new Error(`Unable to resolve OpenAPI reference: ${ref}`);
        }
        current = current[segment];
    }
    return current;
}
function dereferenceSchema(spec, schema) {
    if (Array.isArray(schema)) {
        return schema.map((entry) => dereferenceSchema(spec, entry));
    }
    if (!schema || typeof schema !== 'object') {
        return schema;
    }
    const asRecord = schema;
    if (typeof asRecord.$ref === 'string') {
        return dereferenceSchema(spec, resolvePointer(spec, asRecord.$ref));
    }
    return Object.fromEntries(Object.entries(asRecord).map(([key, value]) => [key, dereferenceSchema(spec, value)]));
}
function createSchemaValidator(spec, ref) {
    const ajv = new ajv_1.default({ allErrors: true, strict: false });
    ajv.addFormat('date-time', {
        type: 'string',
        validate: (value) => !Number.isNaN(Date.parse(value)),
    });
    const schema = dereferenceSchema(spec, resolvePointer(spec, ref));
    return ajv.compile(schema);
}
function hasOperation(spec, method, path) {
    const operation = spec.paths?.[path]?.[method.toLowerCase()];
    return Boolean(operation);
}
//# sourceMappingURL=contract.js.map
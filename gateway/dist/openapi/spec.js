"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOpenApiSpec = loadOpenApiSpec;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const js_yaml_1 = __importDefault(require("js-yaml"));
function loadOpenApiSpec() {
    const candidates = [
        path_1.default.resolve(__dirname, './cotsel-dashboard-gateway.openapi.yml'),
        path_1.default.resolve(__dirname, '../../../docs/api/cotsel-dashboard-gateway.openapi.yml'),
        path_1.default.resolve(process.cwd(), 'docs/api/cotsel-dashboard-gateway.openapi.yml'),
        path_1.default.resolve(__dirname, '../../dist/openapi/cotsel-dashboard-gateway.openapi.yml'),
    ];
    const specPath = candidates.find((candidate) => fs_1.default.existsSync(candidate));
    if (!specPath) {
        throw new Error('Unable to locate dashboard gateway OpenAPI spec');
    }
    const parsed = js_yaml_1.default.load(fs_1.default.readFileSync(specPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Dashboard gateway OpenAPI spec is invalid');
    }
    return parsed;
}
//# sourceMappingURL=spec.js.map
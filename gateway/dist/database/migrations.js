"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
async function runMigrations(pool) {
    const candidates = [
        path_1.default.resolve(__dirname, 'schema.sql'),
        path_1.default.resolve(__dirname, '../../src/database/schema.sql'),
        path_1.default.resolve(process.cwd(), 'gateway/src/database/schema.sql'),
        path_1.default.resolve(process.cwd(), 'src/database/schema.sql'),
    ];
    const schemaPath = candidates.find((candidate) => fs_1.default.existsSync(candidate));
    if (!schemaPath) {
        throw new Error('Unable to locate gateway schema.sql');
    }
    const sql = fs_1.default.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
}
//# sourceMappingURL=migrations.js.map
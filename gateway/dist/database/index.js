"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPool = createPool;
exports.testConnection = testConnection;
exports.closeConnection = closeConnection;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const pg_1 = require("pg");
const logger_1 = require("../logging/logger");
function createPool(config) {
    const pool = new pg_1.Pool({
        host: config.dbHost,
        port: config.dbPort,
        database: config.dbName,
        user: config.dbUser,
        password: config.dbPassword,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    pool.on('connect', () => {
        logger_1.Logger.debug('New database connection established');
    });
    pool.on('error', (error) => {
        logger_1.Logger.error('Unexpected database error', error);
    });
    return pool;
}
async function testConnection(pool) {
    await pool.query('SELECT NOW() AS current_time');
}
async function closeConnection(pool) {
    await pool.end();
}
//# sourceMappingURL=index.js.map
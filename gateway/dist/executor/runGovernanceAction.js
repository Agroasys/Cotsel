"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const index_1 = require("../database/index");
const migrations_1 = require("../database/migrations");
const executorEnv_1 = require("../config/executorEnv");
const auditLogStore_1 = require("../core/auditLogStore");
const governanceStore_1 = require("../core/governanceStore");
const governanceWriteStore_1 = require("../core/governanceWriteStore");
const governanceStatusService_1 = require("../core/governanceStatusService");
const logger_1 = require("../logging/logger");
const governanceExecutor_1 = require("./governanceExecutor");
const adminSdkGovernanceChainExecutor_1 = require("./adminSdkGovernanceChainExecutor");
const runGovernanceActionStatus_1 = require("./runGovernanceActionStatus");
async function main() {
    const actionId = process.argv[2]?.trim();
    if (!actionId) {
        throw new Error('Usage: npm run -w gateway execute:governance-action -- <actionId>');
    }
    const config = (0, executorEnv_1.loadExecutorConfig)();
    const pool = (0, index_1.createPool)(config);
    try {
        await (0, index_1.testConnection)(pool);
        await (0, migrations_1.runMigrations)(pool);
        const governanceActionStore = (0, governanceStore_1.createPostgresGovernanceActionStore)(pool);
        const service = new governanceExecutor_1.GovernanceExecutorService(governanceActionStore, (0, governanceWriteStore_1.createPostgresGovernanceWriteStore)(pool, governanceActionStore), (0, auditLogStore_1.createPostgresAuditLogStore)(pool), (0, governanceStatusService_1.createGovernanceStatusService)(config), (0, governanceExecutor_1.createPostgresGovernanceExecutionLock)(pool), (0, adminSdkGovernanceChainExecutor_1.createAdminSdkGovernanceChainExecutor)(config), config.executionTimeoutMs);
        const requestId = `executor-${(0, crypto_1.randomUUID)()}`;
        const result = await service.executeAction(actionId, requestId, requestId);
        logger_1.Logger.info('Governance action executor completed', {
            requestId,
            actionId,
            status: result.status,
            txHash: result.txHash,
            proposalId: result.proposalId,
            blockNumber: result.blockNumber,
        });
        if ((0, runGovernanceActionStatus_1.shouldExitNonZeroForGovernanceAction)(result.status)) {
            process.exitCode = 1;
        }
    }
    finally {
        await (0, index_1.closeConnection)(pool);
    }
}
main().catch((error) => {
    logger_1.Logger.error('Governance action executor failed', error);
    process.exit(1);
});
//# sourceMappingURL=runGovernanceAction.js.map
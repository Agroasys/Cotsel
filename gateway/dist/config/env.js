"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const dotenv_1 = __importDefault(require("dotenv"));
const assert_1 = require("assert");
const ethers_1 = require("ethers");
const sdk_1 = require("@agroasys/sdk");
dotenv_1.default.config();
function env(name) {
    const value = process.env[name];
    (0, assert_1.strict)(value, `${name} is missing`);
    return value;
}
function optionalEnv(name) {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}
function envNumber(name, fallback) {
    const raw = process.env[name];
    if ((raw === undefined || raw === '') && fallback !== undefined) {
        return fallback;
    }
    const value = raw ?? env(name);
    const parsed = Number.parseInt(value, 10);
    (0, assert_1.strict)(!Number.isNaN(parsed), `${name} must be a number`);
    return parsed;
}
function envBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    if (raw.toLowerCase() === 'true') {
        return true;
    }
    if (raw.toLowerCase() === 'false') {
        return false;
    }
    throw new Error(`${name} must be true or false`);
}
function parseAllowlist(raw) {
    if (!raw) {
        return [];
    }
    return raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}
function parseUrlList(raw) {
    if (!raw) {
        return [];
    }
    return raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => value.replace(/\/$/, ''));
}
function assertAddress(name, value) {
    (0, assert_1.strict)((0, ethers_1.isAddress)(value), `${name} must be a valid EVM address`);
    return (0, ethers_1.getAddress)(value);
}
function loadConfig() {
    const buildTime = process.env.GATEWAY_BUILD_TIME?.trim() || new Date().toISOString();
    const authBaseUrl = env('GATEWAY_AUTH_BASE_URL').replace(/\/$/, '');
    const indexerGraphqlUrl = env('GATEWAY_INDEXER_GRAPHQL_URL').replace(/\/$/, '');
    const escrowAddress = assertAddress('GATEWAY_ESCROW_ADDRESS', env('GATEWAY_ESCROW_ADDRESS'));
    const runtime = (0, sdk_1.resolveSettlementRuntime)({
        runtimeKey: optionalEnv('GATEWAY_SETTLEMENT_RUNTIME'),
        rpcUrl: optionalEnv('GATEWAY_RPC_URL'),
        rpcFallbackUrls: parseUrlList(process.env.GATEWAY_RPC_FALLBACK_URLS),
        chainId: process.env.GATEWAY_CHAIN_ID ? envNumber('GATEWAY_CHAIN_ID') : null,
        explorerBaseUrl: optionalEnv('GATEWAY_EXPLORER_BASE_URL'),
        escrowAddress,
        usdcAddress: optionalEnv('GATEWAY_USDC_ADDRESS'),
    });
    const rpcUrl = runtime.rpcUrl;
    const rpcFallbackUrls = runtime.rpcFallbackUrls;
    const chainId = runtime.chainId;
    const writeAllowlist = parseAllowlist(process.env.GATEWAY_WRITE_ALLOWLIST);
    const enableMutations = envBool('GATEWAY_ENABLE_MUTATIONS', false);
    const settlementIngressEnabled = envBool('GATEWAY_SETTLEMENT_INGRESS_ENABLED', false);
    const settlementServiceAuthApiKeysJson = process.env.GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON?.trim() || '[]';
    const settlementServiceAuthSharedSecret = process.env.GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET?.trim() || undefined;
    const settlementCallbackEnabled = envBool('GATEWAY_SETTLEMENT_CALLBACK_ENABLED', false);
    const settlementCallbackUrl = process.env.GATEWAY_SETTLEMENT_CALLBACK_URL?.trim()?.replace(/\/$/, '') || undefined;
    const settlementCallbackApiKey = process.env.GATEWAY_SETTLEMENT_CALLBACK_API_KEY?.trim() || undefined;
    const settlementCallbackApiSecret = process.env.GATEWAY_SETTLEMENT_CALLBACK_API_SECRET?.trim() || undefined;
    const oracleBaseUrl = process.env.GATEWAY_ORACLE_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
    const treasuryBaseUrl = process.env.GATEWAY_TREASURY_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
    const reconciliationBaseUrl = process.env.GATEWAY_RECONCILIATION_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
    const ricardianBaseUrl = process.env.GATEWAY_RICARDIAN_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
    const notificationsBaseUrl = process.env.GATEWAY_NOTIFICATIONS_BASE_URL?.trim()?.replace(/\/$/, '') || undefined;
    const oracleServiceApiKey = process.env.GATEWAY_ORACLE_SERVICE_API_KEY?.trim() || undefined;
    const oracleServiceApiSecret = process.env.GATEWAY_ORACLE_SERVICE_API_SECRET?.trim() || undefined;
    const treasuryServiceApiKey = process.env.GATEWAY_TREASURY_SERVICE_API_KEY?.trim() || undefined;
    const treasuryServiceApiSecret = process.env.GATEWAY_TREASURY_SERVICE_API_SECRET?.trim() || undefined;
    const ricardianServiceApiKey = process.env.GATEWAY_RICARDIAN_SERVICE_API_KEY?.trim() || undefined;
    const ricardianServiceApiSecret = process.env.GATEWAY_RICARDIAN_SERVICE_API_SECRET?.trim() || undefined;
    const nodeEnv = process.env.NODE_ENV || 'development';
    (0, assert_1.strict)(authBaseUrl.startsWith('http://') || authBaseUrl.startsWith('https://'), 'GATEWAY_AUTH_BASE_URL must be an absolute http(s) URL');
    (0, assert_1.strict)(indexerGraphqlUrl.startsWith('http://') || indexerGraphqlUrl.startsWith('https://'), 'GATEWAY_INDEXER_GRAPHQL_URL must be an absolute http(s) URL');
    (0, assert_1.strict)(rpcUrl.startsWith('http://') || rpcUrl.startsWith('https://'), 'GATEWAY_RPC_URL must be an absolute http(s) URL');
    for (const [index, fallbackUrl] of rpcFallbackUrls.entries()) {
        (0, assert_1.strict)(fallbackUrl.startsWith('http://') || fallbackUrl.startsWith('https://'), `GATEWAY_RPC_FALLBACK_URLS[${index}] must be an absolute http(s) URL`);
    }
    for (const [name, value] of [
        ['GATEWAY_ORACLE_BASE_URL', oracleBaseUrl],
        ['GATEWAY_TREASURY_BASE_URL', treasuryBaseUrl],
        ['GATEWAY_RECONCILIATION_BASE_URL', reconciliationBaseUrl],
        ['GATEWAY_RICARDIAN_BASE_URL', ricardianBaseUrl],
        ['GATEWAY_NOTIFICATIONS_BASE_URL', notificationsBaseUrl],
    ]) {
        if (!value) {
            continue;
        }
        (0, assert_1.strict)(value.startsWith('http://') || value.startsWith('https://'), `${name} must be an absolute http(s) URL`);
    }
    (0, assert_1.strict)(envNumber('PORT', 3600) > 0, 'PORT must be > 0');
    (0, assert_1.strict)(envNumber('DB_PORT', 5432) > 0, 'DB_PORT must be > 0');
    (0, assert_1.strict)(chainId > 0, 'GATEWAY_CHAIN_ID must be > 0');
    (0, assert_1.strict)(envNumber('GATEWAY_AUTH_REQUEST_TIMEOUT_MS', 5000) >= 1000, 'GATEWAY_AUTH_REQUEST_TIMEOUT_MS must be >= 1000');
    (0, assert_1.strict)(envNumber('GATEWAY_INDEXER_REQUEST_TIMEOUT_MS', 5000) >= 1000, 'GATEWAY_INDEXER_REQUEST_TIMEOUT_MS must be >= 1000');
    (0, assert_1.strict)(envNumber('GATEWAY_RPC_READ_TIMEOUT_MS', 8000) >= 1000, 'GATEWAY_RPC_READ_TIMEOUT_MS must be >= 1000');
    (0, assert_1.strict)(envNumber('GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS', 86400) >= 60, 'GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS must be >= 60');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS', 300) >= 30, 'GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS must be >= 30');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS', 600) >= 60, 'GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS must be >= 60');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_CALLBACK_REQUEST_TIMEOUT_MS', 5000) >= 1000, 'GATEWAY_SETTLEMENT_CALLBACK_REQUEST_TIMEOUT_MS must be >= 1000');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_CALLBACK_POLL_INTERVAL_MS', 5000) >= 1000, 'GATEWAY_SETTLEMENT_CALLBACK_POLL_INTERVAL_MS must be >= 1000');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_ATTEMPTS', 8) >= 1, 'GATEWAY_SETTLEMENT_CALLBACK_MAX_ATTEMPTS must be >= 1');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS', 2000) >= 250, 'GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS must be >= 250');
    (0, assert_1.strict)(envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_BACKOFF_MS', 60000) >= envNumber('GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS', 2000), 'GATEWAY_SETTLEMENT_CALLBACK_MAX_BACKOFF_MS must be >= GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS');
    (0, assert_1.strict)(envNumber('GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET', 1) >= 0, 'GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET must be >= 0');
    (0, assert_1.strict)(envNumber('GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET', 0) >= 0, 'GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET must be >= 0');
    (0, assert_1.strict)(envNumber('GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS', 5000) >= 1000, 'GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS must be >= 1000');
    (0, assert_1.strict)(envNumber('GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS', 8000) >= 1000, 'GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS must be >= 1000');
    if ((oracleServiceApiKey && !oracleServiceApiSecret) || (!oracleServiceApiKey && oracleServiceApiSecret)) {
        throw new Error('GATEWAY_ORACLE_SERVICE_API_KEY and GATEWAY_ORACLE_SERVICE_API_SECRET must be set together');
    }
    if ((treasuryServiceApiKey && !treasuryServiceApiSecret) || (!treasuryServiceApiKey && treasuryServiceApiSecret)) {
        throw new Error('GATEWAY_TREASURY_SERVICE_API_KEY and GATEWAY_TREASURY_SERVICE_API_SECRET must be set together');
    }
    if ((ricardianServiceApiKey && !ricardianServiceApiSecret) || (!ricardianServiceApiKey && ricardianServiceApiSecret)) {
        throw new Error('GATEWAY_RICARDIAN_SERVICE_API_KEY and GATEWAY_RICARDIAN_SERVICE_API_SECRET must be set together');
    }
    if (settlementIngressEnabled) {
        (0, assert_1.strict)(settlementServiceAuthApiKeysJson !== '[]' || settlementServiceAuthSharedSecret, 'GATEWAY_SETTLEMENT_INGRESS_ENABLED requires GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON or GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET');
    }
    if (settlementCallbackEnabled) {
        (0, assert_1.strict)(settlementCallbackUrl, 'GATEWAY_SETTLEMENT_CALLBACK_URL is required when GATEWAY_SETTLEMENT_CALLBACK_ENABLED=true');
        (0, assert_1.strict)(settlementCallbackUrl.startsWith('http://') || settlementCallbackUrl.startsWith('https://'), 'GATEWAY_SETTLEMENT_CALLBACK_URL must be an absolute http(s) URL');
        (0, assert_1.strict)(settlementCallbackApiKey, 'GATEWAY_SETTLEMENT_CALLBACK_API_KEY is required when GATEWAY_SETTLEMENT_CALLBACK_ENABLED=true');
        (0, assert_1.strict)(settlementCallbackApiSecret, 'GATEWAY_SETTLEMENT_CALLBACK_API_SECRET is required when GATEWAY_SETTLEMENT_CALLBACK_ENABLED=true');
    }
    return {
        port: envNumber('PORT', 3600),
        dbHost: env('DB_HOST'),
        dbPort: envNumber('DB_PORT', 5432),
        dbName: env('DB_NAME'),
        dbUser: env('DB_USER'),
        dbPassword: env('DB_PASSWORD'),
        authBaseUrl,
        authRequestTimeoutMs: envNumber('GATEWAY_AUTH_REQUEST_TIMEOUT_MS', 5000),
        indexerGraphqlUrl,
        indexerRequestTimeoutMs: envNumber('GATEWAY_INDEXER_REQUEST_TIMEOUT_MS', 5000),
        rpcUrl,
        rpcFallbackUrls,
        rpcReadTimeoutMs: envNumber('GATEWAY_RPC_READ_TIMEOUT_MS', 8000),
        chainId,
        escrowAddress: assertAddress('GATEWAY_ESCROW_ADDRESS', runtime.escrowAddress ?? escrowAddress),
        settlementRuntimeKey: runtime.runtimeKey,
        networkName: runtime.networkName,
        explorerBaseUrl: runtime.explorerBaseUrl,
        enableMutations,
        writeAllowlist,
        governanceQueueTtlSeconds: envNumber('GATEWAY_GOVERNANCE_QUEUE_TTL_SECONDS', 86400),
        settlementIngressEnabled,
        settlementServiceAuthApiKeysJson,
        settlementServiceAuthSharedSecret,
        settlementServiceAuthMaxSkewSeconds: envNumber('GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS', 300),
        settlementServiceAuthNonceTtlSeconds: envNumber('GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS', 600),
        settlementCallbackEnabled,
        settlementCallbackUrl,
        settlementCallbackApiKey,
        settlementCallbackApiSecret,
        settlementCallbackRequestTimeoutMs: envNumber('GATEWAY_SETTLEMENT_CALLBACK_REQUEST_TIMEOUT_MS', 5000),
        settlementCallbackPollIntervalMs: envNumber('GATEWAY_SETTLEMENT_CALLBACK_POLL_INTERVAL_MS', 5000),
        settlementCallbackMaxAttempts: envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_ATTEMPTS', 8),
        settlementCallbackInitialBackoffMs: envNumber('GATEWAY_SETTLEMENT_CALLBACK_INITIAL_BACKOFF_MS', 2000),
        settlementCallbackMaxBackoffMs: envNumber('GATEWAY_SETTLEMENT_CALLBACK_MAX_BACKOFF_MS', 60000),
        oracleBaseUrl,
        oracleServiceApiKey,
        oracleServiceApiSecret,
        treasuryBaseUrl,
        treasuryServiceApiKey,
        treasuryServiceApiSecret,
        reconciliationBaseUrl,
        ricardianBaseUrl,
        ricardianServiceApiKey,
        ricardianServiceApiSecret,
        notificationsBaseUrl,
        downstreamReadRetryBudget: envNumber('GATEWAY_DOWNSTREAM_READ_RETRY_BUDGET', 1),
        downstreamMutationRetryBudget: envNumber('GATEWAY_DOWNSTREAM_MUTATION_RETRY_BUDGET', 0),
        downstreamReadTimeoutMs: envNumber('GATEWAY_DOWNSTREAM_READ_TIMEOUT_MS', 5000),
        downstreamMutationTimeoutMs: envNumber('GATEWAY_DOWNSTREAM_MUTATION_TIMEOUT_MS', 8000),
        commitSha: process.env.GATEWAY_COMMIT_SHA?.trim() || 'local-dev',
        buildTime,
        nodeEnv,
    };
}
//# sourceMappingURL=env.js.map
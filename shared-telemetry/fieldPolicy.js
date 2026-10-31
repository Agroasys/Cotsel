'use strict';

/**
 * Default-deny telemetry field schema (WP-8 COMP-04 / FAIL-17).
 *
 * A field reaches logs, metric events, or alerts only when its name is listed
 * here. Unlisted fields are removed and named in `telemetryDroppedFields`, so a
 * missing classification is visible without the value ever being emitted.
 * Prohibited names are replaced with a marker even if someone lists them.
 *
 * Classes follow docs/security/data-classification-policy.md. Every emitted
 * string is still scrubbed for secrets and personal data by value.
 */

const TELEMETRY_SCHEMA_VERSION = 'telemetry-schema.v1';

const FIELD_CLASS = Object.freeze({
  PUBLIC: 'public_operational',
  INTERNAL: 'internal_operational',
  // Reduced to scheme and host: RPC and webhook URLs carry keys in the path.
  ENDPOINT: 'endpoint_origin',
  // A request target: the query and fragment are dropped.
  REQUEST_PATH: 'request_path',
  // Personal data: truncated to the network prefix.
  NETWORK_ADDRESS: 'masked_network_address',
});

const PUBLIC_FIELDS = [
  // Record envelope.
  'level',
  'timestamp',
  'time',
  'service',
  'env',
  'environment',
  'nodeEnv',
  'message',
  'msg',
  'action',
  'ns',
  'metric',
  'value',
  // Correlation.
  'tradeId',
  'actionKey',
  'requestId',
  'correlationId',
  'traceId',
  'runKey',
  'eventId',
  'eventType',
  'eventName',
  'type',
  'kind',
  'source',
  // Chain and execution references.
  'txHash',
  'transactionHash',
  'signedTransactionHash',
  'observedTransactionHash',
  'transactionType',
  'transactionNonce',
  'blockNumber',
  'blockHash',
  'expectedBlockHash',
  'observedBlockHash',
  'startBlock',
  'stableBlockNumber',
  'finalityBlockNumber',
  'boundaryBlock',
  'boundaryTag',
  'blockInterval',
  'logIndex',
  'contractAddress',
  'codehash',
  'abiFingerprint',
  'startBlockVerified',
  'finalizedBlock',
  'head',
  'checkpointHeight',
  'checkpointState',
  'checked',
  'chainId',
  'networkName',
  'escrowAddress',
  'oracleAddress',
  'signerAddress',
  'walletAddress',
  'actorWallet',
  'intentHash',
  'signatureHash',
  'hash',
  'storedHash',
  'documentRef',
  'evidenceRef',
  'evidenceId',
  'reorgDepth',
  'lagBlocks',
  'maxLagBlocks',
  // Request shape.
  'method',
  'operation',
  'operationName',
  'statusCode',
  'responseStatus',
  'durationMs',
  'port',
  // Outcome and failure classification.
  'intent',
  'outcome',
  'outcomeStatus',
  'previousOutcomeStatus',
  'status',
  'currentStatus',
  'tradeStatus',
  'state',
  'observedState',
  'containmentState',
  'severity',
  'critical',
  'high',
  'errorCode',
  'errorName',
  'errorType',
  'failureClass',
  'failureCode',
  'mismatchCode',
  'qualifyingCodes',
  'code',
  'retryable',
  'replayable',
  'isTerminal',
  'signal',
  'effect',
  // Counters, windows, and timings.
  'attempt',
  'attempts',
  'attemptCount',
  'previousAttempts',
  'remainingAttempts',
  'maxAttempts',
  'maxRetries',
  'nextAttempt',
  'backoffMs',
  'maxBackoffMs',
  'delayMs',
  'maxDelayMs',
  'exponentialDelay',
  'cappedExponentialDelay',
  'jitter',
  'totalDelay',
  'cooldownMs',
  'escalateAfterMs',
  'intervalMs',
  'ingestionIntervalMs',
  'windowSeconds',
  'windowSize',
  'ageSeconds',
  'maxAgeSeconds',
  'coverageMaxAgeMs',
  'currentTime',
  'startedAt',
  'approvedAt',
  'rejectedAt',
  'expiresAt',
  'leaseExpiresAt',
  'lastHeartbeatAt',
  'batchSize',
  'limit',
  'requested',
  'returned',
  'fetched',
  'inserted',
  'walked',
  'entryCount',
  'totalTrades',
  'driftCount',
  'observationCount',
  'unresolvedCount',
  'consecutiveFailureCount',
  'takeoverCount',
  'allowlistSize',
  'pending',
  'deadLetters',
  'awaitingEscalation',
  'currentValue',
  'chainTradeCounter',
  'maxTradesPerRun',
  // Reconciliation and ingestion coverage.
  'fromTradeId',
  'toTradeId',
  'coveredFromTradeId',
  'coveredToTradeId',
  'expectedTradeId',
  'foundTradeId',
  'heldAtTradeId',
  'scannedFromId',
  'nextCursor',
  'cursorAdvanced',
  'coverageBoundary',
  'coverageComplete',
  'windowComplete',
  'windowExhausted',
  'uncoveredTail',
  'slaBreached',
  'statusRecorded',
  'sweepReset',
  'indexerEnumerationTruncated',
  'indexerEnumerationWalked',
  'indexerProcessed',
  'indexerProcessedBlock',
  'indexerProcessedBlockNumber',
  'ingestedThroughBlockNumber',
  'nextTradeBlockNumber',
  'nextClaimBlockNumber',
  'tradeWatermark',
  'claimWatermark',
  'range',
  // Runtime flags.
  'mode',
  'custodyMode',
  'authEnabled',
  'mutationsEnabled',
  'rateLimitEnabled',
  'rateLimitMode',
  'ingestionWorkerEnabled',
  'providerCallbackAuthEnabled',
  'payoutCancelled',
  'isRedrive',
  'deadLetter',
  'fallback',
  'rulesVersion',
];

const INTERNAL_FIELDS = [
  // Actors: pseudonymous principal references, never profile data.
  'userId',
  'accountId',
  'actorId',
  'actor',
  'actorUserId',
  'actorSessionId',
  'actorRole',
  'role',
  'gatewayRoles',
  'requestedRole',
  'issuedRole',
  'effectiveRole',
  'previousRole',
  'newRole',
  'change',
  'changeId',
  'apiKeyId',
  'exchangeKeyId',
  'workerIdentity',
  'owner',
  'leaseOwner',
  'previousOwner',
  'abandonedOwner',
  'leaseEpoch',
  'epoch',
  // Workflow references.
  'idempotencyKey',
  'applicationRequestId',
  'existingRequestId',
  'newRequestId',
  'previousRequestId',
  'deliveryId',
  'handoffId',
  'exportId',
  'outboxId',
  'alertId',
  'dedupKey',
  'incidentReference',
  'ledgerEntryId',
  'entryKey',
  'resourceId',
  'providerRef',
  'subjectRef',
  'decisionId',
  'ticketRef',
  'signatureRef',
  'accountLast4',
  'ibanLast4',
  'triggerType',
  'proposalSet',
  'proposalCounter',
  'nonce',
  'confirmedSignerNonce',
  'pendingSignerNonce',
  'configKey',
  'keyPrefix',
  'nonceStore',
  'column',
  'fields',
  'knownStatuses',
  'graphqlCtx',
  'rpcId',
  'rpcBatchId',
  'req',
  // Failure detail. Free text: scrubbed by value before it is emitted.
  'error',
  'errors',
  'err',
  'errorMessage',
  'readError',
  'stack',
  'reason',
  'reasons',
  'cause',
  'failureReason',
  'mismatchReason',
  'blockedReason',
  'blockedReasons',
  'details',
  'diagnostics',
  'extensions',
  'locations',
  'line',
  'stage',
  'discardedFindings',
  'anchorBlock',
  'telemetryDroppedFields',
];

const ENDPOINT_FIELDS = [
  'rpcUrl',
  'fallbackRpcUrls',
  'graphqlUrl',
  'indexerGraphqlUrl',
  'authBaseUrl',
];

const REQUEST_PATH_FIELDS = ['route', 'path', 'endpoint'];

const NETWORK_ADDRESS_FIELDS = ['ip'];

function normalizeFieldName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Exact names from docs/security/data-classification-policy.md and
// scripts/tests/data-classification-guard.mjs, plus raw credential carriers.
const PROHIBITED_EXACT = new Set(
  [
    'privateKey',
    'privateKeys',
    'seedPhrase',
    'mnemonic',
    'apiKey',
    'apiSecret',
    'accessToken',
    'refreshToken',
    'bearerToken',
    'sessionToken',
    'idToken',
    'token',
    'hmacSecret',
    'hmacKey',
    'signatureSecret',
    'canonicalString',
    'signature',
    'bankAccountNumber',
    'accountNumber',
    'routingNumber',
    'iban',
    'swiftCode',
    'swift',
    'bic',
    'passportNumber',
    'nationalId',
    'dateOfBirth',
    'email',
    'phone',
    'phoneNumber',
    'userAgent',
    'headers',
    'rawBody',
  ].map(normalizeFieldName),
);

// Any name containing one of these is credential material whatever it is called.
const PROHIBITED_FRAGMENTS = [
  'privatekey',
  'seedphrase',
  'mnemonic',
  'secret',
  'password',
  'passwd',
  'bearer',
  'cookie',
  'authorization',
  'credential',
];

function isProhibitedField(name) {
  const normalized = normalizeFieldName(name);
  if (PROHIBITED_EXACT.has(normalized)) return true;
  return PROHIBITED_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function buildFieldPolicy() {
  const policy = new Map();
  const register = (names, fieldClass) => {
    for (const name of names) {
      if (policy.has(name)) {
        throw new Error(`telemetry field ${name} is classified twice`);
      }
      policy.set(name, fieldClass);
    }
  };
  register(PUBLIC_FIELDS, FIELD_CLASS.PUBLIC);
  register(INTERNAL_FIELDS, FIELD_CLASS.INTERNAL);
  register(ENDPOINT_FIELDS, FIELD_CLASS.ENDPOINT);
  register(REQUEST_PATH_FIELDS, FIELD_CLASS.REQUEST_PATH);
  register(NETWORK_ADDRESS_FIELDS, FIELD_CLASS.NETWORK_ADDRESS);
  return policy;
}

const TELEMETRY_FIELD_POLICY = buildFieldPolicy();

function classifyTelemetryField(name) {
  if (isProhibitedField(name)) return 'prohibited';
  return TELEMETRY_FIELD_POLICY.get(name) ?? 'unclassified';
}

module.exports = {
  FIELD_CLASS,
  TELEMETRY_FIELD_POLICY,
  TELEMETRY_SCHEMA_VERSION,
  classifyTelemetryField,
  isProhibitedField,
};

/** SPDX-License-Identifier: Apache-2.0 */
import { parseSettlementUserActionBinding } from '../settlementUserActionBinding';
import { GASLESS_TRANSACTION_OUTCOME_STATUSES } from '../gaslessTransactionOutcomeStore';
import { validateSignedIdentity } from './signedIdentity';
import { deny, fingerprint } from './validation';
import type { UserActionInventoryRequest } from './inventory';
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function keys(
  value: unknown,
  allowed: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !optional.includes(key) && !(key in value))
  )
    deny('Retained operation inventory is malformed');
}
function finality(
  value: unknown,
  request: UserActionInventoryRequest,
  outcome: UserActionInventoryRequest['outcomes'][number],
) {
  if (value === null) return;
  keys(
    value,
    [
      'policyVersion',
      'chainId',
      'transactionHash',
      'blockNumber',
      'blockHash',
      'finalizedBlockNumber',
      'finalizedBlockHash',
      'rpcWitnesses',
      'projectionCoverage',
    ],
    ['projectionCoverage'],
  );
  if (
    value.policyVersion !== 'gasless_dual_rpc_finalized_v1' ||
    !decimal(value.chainId) ||
    value.chainId !== request.chainId ||
    value.transactionHash !== outcome.transaction_hash ||
    !decimal(value.blockNumber) ||
    value.blockNumber !== outcome.block_number ||
    !hash(value.blockHash) ||
    value.blockHash !== outcome.block_hash ||
    !decimal(value.finalizedBlockNumber) ||
    BigInt(value.finalizedBlockNumber) < BigInt(value.blockNumber) ||
    !hash(value.finalizedBlockHash) ||
    !Array.isArray(value.rpcWitnesses) ||
    value.rpcWitnesses.length !== 2 ||
    !value.rpcWitnesses.every(hash) ||
    new Set(value.rpcWitnesses).size !== 2
  )
    deny('Retained finality inventory is malformed');
  if (
    value.blockNumber === value.finalizedBlockNumber &&
    value.blockHash !== value.finalizedBlockHash
  )
    deny('Retained finality anchor is inconsistent');
  if (value.projectionCoverage !== undefined) {
    const projection = value.projectionCoverage;
    keys(projection, ['version', 'tradeId', 'indexer', 'reconciliation']);
    if (
      projection.version !== 'cotsel.financial-projection-coverage.v1' ||
      !decimal(projection.tradeId) ||
      projection.tradeId === '0' ||
      projection.tradeId !== request.binding.tradeId
    )
      deny('Retained projection inventory is malformed');
    keys(projection.indexer, ['blockNumber', 'blockHash']);
    keys(projection.reconciliation, ['runKey', 'blockNumber', 'blockHash', 'verifiedAt']);
    const indexer = projection.indexer,
      reconciliation = projection.reconciliation;
    if (
      !decimal(indexer.blockNumber) ||
      !hash(indexer.blockHash) ||
      !decimal(reconciliation.blockNumber) ||
      !hash(reconciliation.blockHash) ||
      BigInt(reconciliation.blockNumber) < BigInt(value.blockNumber) ||
      BigInt(reconciliation.blockNumber) > BigInt(value.finalizedBlockNumber) ||
      BigInt(indexer.blockNumber) < BigInt(reconciliation.blockNumber) ||
      typeof reconciliation.runKey !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(reconciliation.runKey) ||
      typeof reconciliation.verifiedAt !== 'string' ||
      reconciliation.verifiedAt.length > 32 ||
      !Number.isFinite(Date.parse(reconciliation.verifiedAt)) ||
      new Date(reconciliation.verifiedAt).toISOString() !== reconciliation.verifiedAt ||
      Date.parse(reconciliation.verifiedAt) > Date.now() + 60_000
    )
      deny('Retained projection inventory is malformed');
    for (const anchor of [indexer, reconciliation])
      if (
        (anchor.blockNumber === value.blockNumber && anchor.blockHash !== value.blockHash) ||
        (anchor.blockNumber === value.finalizedBlockNumber &&
          anchor.blockHash !== value.finalizedBlockHash)
      )
        deny('Retained projection anchor is inconsistent');
    if (
      indexer.blockNumber === reconciliation.blockNumber &&
      indexer.blockHash !== reconciliation.blockHash
    )
      deny('Retained projection anchors disagree');
  }
}
/** Exact persisted shape and provenance precede every authenticated response. */
export function validateInventoryRequest(request: UserActionInventoryRequest, owner: string): void {
  keys(request, [
    'requestId',
    'ownerServiceId',
    'sourceOperationId',
    'packageId',
    'handoffId',
    'requestFingerprint',
    'bindingFingerprint',
    'chainId',
    'escrowAddress',
    'userAddress',
    'nonce',
    'binding',
    'status',
    'attempts',
    'outcomes',
  ]);
  const binding = parseSettlementUserActionBinding(request.binding, owner);
  if (
    !uuid(request.requestId) ||
    !uuid(request.handoffId) ||
    !uuid(request.sourceOperationId) ||
    !hash(request.requestFingerprint) ||
    !hash(request.bindingFingerprint) ||
    !['accepted', 'signing'].includes(request.status) ||
    fingerprint(binding) !== request.bindingFingerprint ||
    binding.packageId !== request.packageId ||
    binding.sourceOperationId !== request.sourceOperationId ||
    binding.chainId !== request.chainId ||
    binding.escrowAddress !== request.escrowAddress ||
    binding.signerAddress !== request.userAddress ||
    binding.nonce !== request.nonce ||
    request.ownerServiceId !== owner
  )
    deny('Retained instruction identity is inconsistent');
  if (
    !Array.isArray(request.attempts) ||
    request.attempts.length > 100 ||
    !Array.isArray(request.outcomes) ||
    request.outcomes.length > 10
  )
    deny('Retained operation inventory exceeds automatic bounds');
  let previous = 0n,
    signing = 0,
    signed = 0;
  const signedHashes = new Set<string>(),
    observedHashes = new Set<string>();
  for (const attempt of request.attempts) {
    keys(attempt, ['event_id', 'event_type', 'transaction_hash', 'transaction_identity']);
    if (
      !decimal(attempt.event_id) ||
      BigInt(attempt.event_id) <= previous ||
      !['accepted', 'claimed', 'signing', 'signed', 'provider_hash', 'signer_rejected'].includes(
        attempt.event_type,
      )
    )
      deny('Retained attempt identity is invalid');
    previous = BigInt(attempt.event_id);
    if (attempt.event_type === 'signing') signing++;
    if (
      ['signed', 'provider_hash', 'signer_rejected'].includes(attempt.event_type)
        ? !hash(attempt.transaction_hash)
        : attempt.transaction_hash !== null
    )
      deny('Retained attempt hash is invalid');
    if (attempt.event_type === 'provider_hash') observedHashes.add(attempt.transaction_hash!);
    if (attempt.event_type === 'signed') {
      keys(attempt.transaction_identity, [
        'transactionHash',
        'applicationRequestId',
        'resourceType',
        'resourceId',
        'operation',
        'chainId',
        'signerAddress',
        'nonce',
        'transactionType',
        'destinationAddress',
        'valueWei',
        'gasLimit',
        'maxFeePerGasWei',
        'maxPriorityFeePerGasWei',
        'gasPriceWei',
        'calldataHash',
        'intentHash',
        'sourceApiKeyId',
      ]);
      const identity = attempt.transaction_identity;
      validateSignedIdentity(identity);
      if (
        identity.transactionHash !== attempt.transaction_hash ||
        identity.applicationRequestId !== request.requestId ||
        identity.resourceType !== 'settlement_handoff' ||
        identity.resourceId !== request.handoffId ||
        identity.operation !== binding.action ||
        identity.sourceApiKeyId !== owner ||
        identity.chainId !== Number(request.chainId) ||
        identity.destinationAddress.toLowerCase() !== request.escrowAddress ||
        identity.valueWei !== '0'
      )
        deny('Retained signed identity is inconsistent');
      signed++;
      signedHashes.add(identity.transactionHash);
    } else if (attempt.transaction_identity !== null)
      deny('Retained attempt identity is inconsistent');
  }
  if (
    signing > 1 ||
    signed > 1 ||
    (request.status === 'signing' ? signing !== 1 : signing !== 0 || signed !== 0)
  )
    deny('Retained signing history is inconsistent');
  const outcomeHashes = new Set<string>();
  for (const outcome of request.outcomes) {
    keys(outcome, [
      'transaction_hash',
      'observed_transaction_hash',
      'outcome_status',
      'block_number',
      'block_hash',
      'finality_evidence',
    ]);
    if (
      !hash(outcome.transaction_hash) ||
      !signedHashes.has(outcome.transaction_hash) ||
      outcomeHashes.has(outcome.transaction_hash) ||
      !(GASLESS_TRANSACTION_OUTCOME_STATUSES as readonly string[]).includes(
        outcome.outcome_status,
      ) ||
      (outcome.observed_transaction_hash !== null &&
        (!hash(outcome.observed_transaction_hash) ||
          !observedHashes.has(outcome.observed_transaction_hash))) ||
      (outcome.block_number !== null && !decimal(outcome.block_number)) ||
      (outcome.block_hash !== null && !hash(outcome.block_hash)) ||
      (outcome.block_number === null) !== (outcome.block_hash === null)
    )
      deny('Retained outcome identity is invalid');
    outcomeHashes.add(outcome.transaction_hash);
    if (
      ['confirmed', 'reverted'].includes(outcome.outcome_status) &&
      (outcome.block_number === null || outcome.finality_evidence === null)
    )
      deny('Retained terminal outcome is missing finality');
    finality(outcome.finality_evidence, request, outcome);
  }
}

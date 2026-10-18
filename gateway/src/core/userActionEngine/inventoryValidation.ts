/** SPDX-License-Identifier: Apache-2.0 */
import { parseSettlementUserActionBinding } from '../settlementUserActionBinding';
import { validateSignedIdentity } from './signedIdentity';
import { deny, fingerprint } from './validation';
import type { UserActionInventoryRequest } from './inventory';
const hash = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    deny('Retained operation inventory is malformed');
}
function strings(value: Record<string, unknown>, names: string[]) {
  for (const name of names)
    if (typeof value[name] !== 'string' || !value[name] || String(value[name]).length > 256)
      deny('Retained operation inventory is malformed');
}
function finality(value: unknown) {
  if (value === null) return;
  keys(value, [
    'policyVersion',
    'chainId',
    'transactionHash',
    'blockNumber',
    'blockHash',
    'finalizedBlockNumber',
    'finalizedBlockHash',
    'rpcWitnesses',
    'projectionCoverage',
  ]);
  strings(value, [
    'policyVersion',
    'chainId',
    'transactionHash',
    'blockNumber',
    'blockHash',
    'finalizedBlockNumber',
    'finalizedBlockHash',
  ]);
  if (
    value.policyVersion !== 'gasless_dual_rpc_finalized_v1' ||
    !hash(value.transactionHash) ||
    !hash(value.blockHash) ||
    !hash(value.finalizedBlockHash) ||
    !Array.isArray(value.rpcWitnesses) ||
    value.rpcWitnesses.length !== 2 ||
    !value.rpcWitnesses.every(hash)
  )
    deny('Retained finality inventory is malformed');
  if (value.projectionCoverage !== undefined) {
    const projection = value.projectionCoverage;
    keys(projection, ['version', 'tradeId', 'indexer', 'reconciliation']);
    strings(projection, ['version', 'tradeId']);
    keys(projection.indexer, ['blockNumber', 'blockHash']);
    strings(projection.indexer, ['blockNumber', 'blockHash']);
    keys(projection.reconciliation, ['runKey', 'blockNumber', 'blockHash', 'verifiedAt']);
    strings(projection.reconciliation, ['runKey', 'blockNumber', 'blockHash', 'verifiedAt']);
    if (
      !hash(projection.indexer.blockHash) ||
      !hash(projection.reconciliation.blockHash) ||
      !Number.isFinite(Date.parse(String(projection.reconciliation.verifiedAt)))
    )
      deny('Retained projection inventory is malformed');
  }
}
/** Validate exact allowlisted persisted fields before any authenticated response. */
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
  for (const attempt of request.attempts) {
    keys(attempt, ['event_id', 'event_type', 'transaction_hash', 'transaction_identity']);
    if (attempt.transaction_hash !== null && !hash(attempt.transaction_hash))
      deny('Retained attempt identity is invalid');
    if (attempt.transaction_identity !== null) {
      validateSignedIdentity(attempt.transaction_identity);
      if (
        attempt.event_type !== 'signed' ||
        attempt.transaction_identity.transactionHash !== attempt.transaction_hash
      )
        deny('Retained signed identity is inconsistent');
    }
  }
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
      (outcome.observed_transaction_hash !== null && !hash(outcome.observed_transaction_hash))
    )
      deny('Retained outcome identity is invalid');
    finality(outcome.finality_evidence);
  }
}

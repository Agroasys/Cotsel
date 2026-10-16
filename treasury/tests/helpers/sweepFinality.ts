import type { TreasuryFinalizedEvidence } from '../../src/core/finalizedTransaction';
/** Controlled evidence for policy-boundary tests; never provider acceptance. */
export function controlledSweepFinality(
  transactionHash = '0xclaim',
  blockNumber = '101',
): TreasuryFinalizedEvidence {
  return {
    policyVersion: 'treasury_dual_rpc_finalized_v1',
    chainId: '31337',
    transactionHash,
    blockNumber,
    blockHash: `0x${'a'.repeat(64)}`,
    rpcWitnesses: ['a'.repeat(64), 'b'.repeat(64)],
    finalizedHeads: [
      { number: '10000', hash: `0x${'b'.repeat(64)}` },
      { number: '10000', hash: `0x${'b'.repeat(64)}` },
    ],
    verifiedAt: new Date().toISOString(),
  };
}

export function controlledTreasuryClaim(batchId: number, sequence: number) {
  return {
    sourceEventId: `claim-sc-${sequence}`,
    matchedSweepBatchId: batchId,
    txHash: `0x${sequence.toString(16).padStart(64, 'a')}`,
    blockNumber: 900 + sequence,
    observedAt: new Date('2026-04-16T09:00:00.000Z'),
    treasuryIdentity: `0x${'aa'.repeat(20)}`,
    payoutReceiver: '0xpayoutreceiver',
    amountRaw: '125000000',
    triggeredBy: `0x${'cc'.repeat(20)}`,
  };
}

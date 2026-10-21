/** SPDX-License-Identifier: Apache-2.0 */
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { Interface, type TransactionReceipt } from 'ethers';

export interface SettlementProjectionCoverage {
  version: 'cotsel.financial-projection-coverage.v1';
  tradeId: string;
  indexer: { blockNumber: string; blockHash: string };
  reconciliation: { runKey: string; blockNumber: string; blockHash: string; verifiedAt: string };
}
export interface ProjectionCoverageConfig {
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  indexerCoverageUrl?: string;
  reconciliationCoverageUrl?: string;
}
const escrow = new Interface(AgroasysEscrow__factory.abi);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,77})$/.test(value) &&
  BigInt(value) <= (1n << 256n) - 1n;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function recent(value: unknown, maxAge: number): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + 60_000 && time >= Date.now() - maxAge;
}
async function read(url: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return null;
  return object(await response.json());
}

/** Consults the existing indexer and reconciler. No new chain observer or parallel comparison is created. */
export async function verifySettlementProjectionCoverage(
  config: ProjectionCoverageConfig,
  receipt: TransactionReceipt,
  finalizedBlockNumber: number,
  canonicalBlock: (height: string, hash: string) => Promise<boolean>,
): Promise<SettlementProjectionCoverage | null> {
  if (
    !config.indexerCoverageUrl ||
    !config.reconciliationCoverageUrl ||
    receipt.to?.toLowerCase() !== config.escrowAddress.toLowerCase()
  )
    return null;
  const tradeIds = new Set<string>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.escrowAddress.toLowerCase()) continue;
    try {
      const parsed = escrow.parseLog(log);
      if (parsed?.args.tradeId !== undefined) tradeIds.add(BigInt(parsed.args.tradeId).toString());
    } catch {
      /* Other contract events cannot establish the funding/payout trade. */
    }
  }
  if (tradeIds.size !== 1) return null;
  const [tradeId] = tradeIds;
  if (!decimal(tradeId)) return null;
  const reconciliationUrl = new URL(config.reconciliationCoverageUrl);
  reconciliationUrl.searchParams.set('tradeId', tradeId);
  reconciliationUrl.searchParams.set('finalizedBlockNumber', String(finalizedBlockNumber));
  const [indexer, reconciliation] = await Promise.all([
    read(config.indexerCoverageUrl),
    read(reconciliationUrl.toString()),
  ]);
  const checkpoint = object(indexer?.checkpoint);
  const coverage = object(reconciliation?.coverage);
  const evidence = object(coverage?.evidence);
  if (
    indexer?.service !== 'indexer' ||
    indexer.ready !== true ||
    !recent(indexer.observedAt, 60_000) ||
    reconciliation?.service !== 'reconciliation' ||
    reconciliation.ready !== true ||
    !recent(reconciliation.observedAt, 60_000) ||
    !checkpoint ||
    !coverage ||
    !evidence ||
    coverage.tradeId !== tradeId ||
    typeof coverage.runKey !== 'string' ||
    !coverage.runKey ||
    !recent(coverage.verifiedAt, 3_600_000) ||
    evidence.version !== 'cotsel.reconciliation-coverage.v1' ||
    evidence.tag !== 'finalized'
  )
    return null;
  for (const point of [checkpoint, evidence]) {
    if (
      point.chainId !== String(config.chainId) ||
      point.escrowAddress !== config.escrowAddress.toLowerCase() ||
      !decimal(point.blockNumber) ||
      !hash(point.blockHash) ||
      BigInt(point.blockNumber) < BigInt(receipt.blockNumber)
    )
      return null;
  }
  const indexerNumber = checkpoint.blockNumber as string;
  const anchorNumber = evidence.blockNumber as string;
  if (
    evidence.indexerProcessedBlock !== anchorNumber ||
    !decimal(evidence.finalizedBlockNumber) ||
    BigInt(anchorNumber) > BigInt(finalizedBlockNumber) ||
    BigInt(indexerNumber) < BigInt(anchorNumber)
  )
    return null;
  if (
    !(await canonicalBlock(indexerNumber, checkpoint.blockHash as string)) ||
    !(await canonicalBlock(anchorNumber, evidence.blockHash as string))
  )
    return null;
  return {
    version: 'cotsel.financial-projection-coverage.v1',
    tradeId,
    indexer: { blockNumber: indexerNumber, blockHash: checkpoint.blockHash as string },
    reconciliation: {
      runKey: coverage.runKey,
      blockNumber: anchorNumber,
      blockHash: evidence.blockHash as string,
      verifiedAt: coverage.verifiedAt,
    },
  };
}

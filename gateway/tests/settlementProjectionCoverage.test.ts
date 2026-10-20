/** SPDX-License-Identifier: Apache-2.0 */
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { Interface } from 'ethers';
import { verifySettlementProjectionCoverage } from '../src/core/settlementProjectionCoverage';

const config = {
  chainId: 84532,
  escrowAddress: `0x${'1'.repeat(40)}`,
  usdcAddress: `0x${'2'.repeat(40)}`,
  indexerCoverageUrl: 'http://indexer.internal/coverage',
  reconciliationCoverageUrl: 'http://reconciliation.internal/coverage',
};
const blockHash = `0x${'b'.repeat(64)}`;
const abi = new Interface(AgroasysEscrow__factory.abi);
const event = abi.encodeEventLog(abi.getEvent('TradeLocked')!, [
  7n,
  `0x${'3'.repeat(40)}`,
  `0x${'4'.repeat(40)}`,
  100n,
  10n,
  10n,
  40n,
  40n,
  `0x${'a'.repeat(64)}`,
]);
const receipt = {
  to: config.escrowAddress,
  blockNumber: 100,
  logs: [{ address: config.escrowAddress, ...event }],
};
function fixture() {
  const indexer = {
    service: 'indexer',
    ready: true,
    observedAt: new Date().toISOString(),
    checkpoint: {
      chainId: '84532',
      escrowAddress: config.escrowAddress,
      blockNumber: '120',
      blockHash,
    },
  };
  const reconciliation = {
    service: 'reconciliation',
    ready: true,
    observedAt: new Date().toISOString(),
    coverage: {
      runKey: 'retained-run',
      tradeId: '7',
      verifiedAt: new Date().toISOString(),
      evidence: {
        version: 'cotsel.reconciliation-coverage.v1',
        chainId: '84532',
        escrowAddress: config.escrowAddress,
        blockNumber: '110',
        blockHash,
        tag: 'finalized',
        finalizedBlockNumber: '110',
        indexerProcessedBlock: '110',
      },
    },
  };
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(String(url).includes('indexer.internal') ? indexer : reconciliation),
        ),
    );
  const canonical = jest.fn().mockResolvedValue(true);
  const verify = () => verifySettlementProjectionCoverage(config, receipt as never, 115, canonical);
  return { indexer, reconciliation, fetch, canonical, verify };
}
describe('retained indexer and reconciliation financial coverage', () => {
  afterEach(() => jest.restoreAllMocks());
  test('requires an actual indexed checkpoint and a matching finalized run that includes the trade', async () => {
    const f = fixture();
    await expect(f.verify()).resolves.toMatchObject({
      tradeId: '7',
      reconciliation: { runKey: 'retained-run' },
    });
    expect(f.canonical.mock.calls).toEqual([
      ['120', blockHash],
      ['110', blockHash],
    ]);
    expect(f.fetch.mock.calls[1][0]).toBe(
      'http://reconciliation.internal/coverage?tradeId=7&finalizedBlockNumber=115',
    );
  });
  test.each([
    'missing',
    'unready',
    'behind',
    'wrong-chain',
    'wrong-contract',
    'wrong-trade',
    'stale-run',
    'safe-only',
    'ahead-of-finality',
    'inconsistent-indexer',
  ])('keeps evidence pending for %s coverage', async (fault) => {
    const f = fixture();
    const e = f.reconciliation.coverage.evidence;
    if (fault === 'missing') f.fetch.mockImplementation(async () => new Response('{}'));
    if (fault === 'unready') f.indexer.ready = false;
    if (fault === 'behind') e.blockNumber = '99';
    if (fault === 'wrong-chain') e.chainId = '1';
    if (fault === 'wrong-contract') e.escrowAddress = config.usdcAddress;
    if (fault === 'wrong-trade') f.reconciliation.coverage.tradeId = '8';
    if (fault === 'stale-run')
      f.reconciliation.coverage.verifiedAt = new Date(Date.now() - 3_600_001).toISOString();
    if (fault === 'safe-only') e.tag = 'safe';
    if (fault === 'ahead-of-finality') {
      e.blockNumber = '116';
      e.indexerProcessedBlock = '116';
      e.finalizedBlockNumber = '116';
    }
    if (fault === 'inconsistent-indexer') f.indexer.checkpoint.blockNumber = '109';
    await expect(f.verify()).resolves.toBeNull();
  });
  test('accepts a retained canonical comparison after finality has advanced over its anchor', async () => {
    const f = fixture();
    f.reconciliation.coverage.evidence.finalizedBlockNumber = '100';
    await expect(f.verify()).resolves.toMatchObject({
      tradeId: '7',
      reconciliation: { blockNumber: '110' },
    });
  });
  test('rejects orphaned coverage even when services report ready', async () => {
    const f = fixture();
    f.canonical.mockResolvedValue(false);
    await expect(f.verify()).resolves.toBeNull();
  });
  test('does not infer coverage from an empty escrow receipt', async () => {
    const f = fixture();
    await expect(
      verifySettlementProjectionCoverage(
        config,
        { ...receipt, logs: [] } as never,
        115,
        f.canonical,
      ),
    ).resolves.toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  test('requires explicit coverage configuration', async () => {
    const f = fixture();
    await expect(
      verifySettlementProjectionCoverage(
        { ...config, reconciliationCoverageUrl: undefined },
        receipt as never,
        115,
        f.canonical,
      ),
    ).resolves.toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

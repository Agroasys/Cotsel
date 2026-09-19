/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08 / FAIL-06: the verdict logic on its own.
 *
 * Each case is a way the chain can disagree with a stored entry. The one case
 * that must never appear is a CANONICAL verdict reached without the block hash
 * and the log matching, because that is precisely "eligible on height alone".
 */
import {
  ChainCanonicalityVerifier,
  computeLogIdentityHash,
  normalizeBlockHash,
  normalizeLogAddress,
  type SettlementChainReader,
} from '../src/core/chainCanonicality';

const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const LOG_ADDRESS = `0x${'11'.repeat(20)}`;
const OTHER_LOG_ADDRESS = `0x${'22'.repeat(20)}`;
const TOPIC = `0x${'ee'.repeat(32)}`;
const LOG = { index: 2, address: LOG_ADDRESS, topics: [TOPIC], data: '0x01' };
const LOG_IDENTITY_HASH = computeLogIdentityHash(LOG);
const ENTRY = {
  txHash: '0xtx',
  blockNumber: 100,
  blockHash: BLOCK_HASH,
  logIndex: 2,
  logAddress: LOG_ADDRESS,
  logIdentityHash: LOG_IDENTITY_HASH,
};
const STABLE_BLOCK = 150;

function reader(overrides: Partial<SettlementChainReader>): SettlementChainReader {
  return {
    async getBlock() {
      return { number: STABLE_BLOCK, hash: BLOCK_HASH };
    },
    async getTransactionReceipt() {
      return { blockNumber: 100, blockHash: BLOCK_HASH, status: 1, logs: [LOG] };
    },
    ...overrides,
  };
}

function verifierFor(overrides: Partial<SettlementChainReader> = {}): ChainCanonicalityVerifier {
  return new ChainCanonicalityVerifier({ provider: reader(overrides) });
}

describe('normalizeBlockHash', () => {
  it('accepts a 32-byte hash in either case and returns one spelling', () => {
    expect(normalizeBlockHash(BLOCK_HASH.toUpperCase().replace('0X', '0x'))).toBe(BLOCK_HASH);
    expect(normalizeBlockHash(` ${BLOCK_HASH} `)).toBe(BLOCK_HASH);
  });

  it('rejects anything that is not a 32-byte hash', () => {
    expect(normalizeBlockHash('0xabc')).toBeNull();
    expect(normalizeBlockHash(`0x${'zz'.repeat(32)}`)).toBeNull();
    expect(normalizeBlockHash(null)).toBeNull();
    expect(normalizeBlockHash(42)).toBeNull();
  });
});

describe('ChainCanonicalityVerifier', () => {
  it('returns CANONICAL when the receipt matches the block and the log', async () => {
    const verdict = await verifierFor().verify(ENTRY, STABLE_BLOCK);
    expect(verdict).toEqual({ state: 'CANONICAL', blockHash: BLOCK_HASH, stableBlockNumber: 150 });
  });

  it('orphans an entry whose transaction has no receipt, and records the depth', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => null,
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'RECEIPT_MISSING', depth: 50 }),
    );
  });

  it('orphans an entry whose receipt is no longer successful', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        status: 0,
        logs: [LOG],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'RECEIPT_REVERTED' }),
    );
  });

  it('orphans an entry whose transaction was re-mined at a different height', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 104,
        blockHash: OTHER_BLOCK_HASH,
        status: 1,
        logs: [LOG],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({
        state: 'ORPHANED',
        reason: 'BLOCK_NUMBER_MISMATCH',
        observedBlockNumber: 104,
      }),
    );
  });

  it('orphans an entry whose height now holds a different block', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: OTHER_BLOCK_HASH,
        status: 1,
        logs: [LOG],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({
        state: 'ORPHANED',
        reason: 'BLOCK_HASH_MISMATCH',
        expectedBlockHash: BLOCK_HASH,
        observedBlockHash: OTHER_BLOCK_HASH,
        depth: 50,
      }),
    );
  });

  it('orphans an entry whose receipt no longer carries the ingested log', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        status: 1,
        logs: [{ ...LOG, index: 9 }],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'LOG_IDENTITY_MISMATCH' }),
    );
  });

  it('reports UNVERIFIED rather than ORPHANED when the entry has no stored identity', async () => {
    const verdict = await verifierFor().verify(
      { ...ENTRY, blockHash: null, logIndex: null, logAddress: null, logIdentityHash: null },
      STABLE_BLOCK,
    );

    expect(verdict.state).toBe('UNVERIFIED');
  });

  it('reports UNVERIFIED when the RPC fails, because an outage is not a reorganization', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => {
        throw new Error('upstream refused the connection');
      },
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'UNVERIFIED', stableBlockNumber: STABLE_BLOCK }),
    );
  });

  it('reports UNVERIFIED and no head when no provider is configured', async () => {
    const verifier = new ChainCanonicalityVerifier({ provider: null });

    expect(verifier.isConfigured()).toBe(false);
    expect(await verifier.resolveStableHead()).toBeNull();
    expect((await verifier.verify(ENTRY, STABLE_BLOCK)).state).toBe('UNVERIFIED');
  });

  it('returns no stable head when the chain cannot report a finalized block', async () => {
    const verifier = verifierFor({
      getBlock: async (tag) => (tag === 'finalized' ? null : { number: 150, hash: BLOCK_HASH }),
    });

    expect(await verifier.resolveStableHead()).toBeNull();
  });

  it('memoizes a block hash within a run and forgets it on reset', async () => {
    const getBlock = jest.fn(async () => ({ number: 100, hash: BLOCK_HASH }));
    const verifier = verifierFor({ getBlock });

    expect(await verifier.resolveBlockHash(100)).toBe(BLOCK_HASH);
    expect(await verifier.resolveBlockHash(100)).toBe(BLOCK_HASH);
    expect(getBlock).toHaveBeenCalledTimes(1);

    verifier.resetCache();
    await verifier.resolveBlockHash(100);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it('never reports a depth below zero for an entry above the stable block', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => null,
    }).verify({ ...ENTRY, blockNumber: 200 }, STABLE_BLOCK);

    expect(verdict).toEqual(expect.objectContaining({ state: 'ORPHANED', depth: 0 }));
  });

  it('orphans a log at the right index emitted by a different contract', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        status: 1,
        logs: [{ ...LOG, address: OTHER_LOG_ADDRESS }],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'LOG_CONTENT_MISMATCH' }),
    );
  });

  it('orphans a log at the right index whose topics no longer match', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        status: 1,
        logs: [{ ...LOG, topics: [`0x${'ff'.repeat(32)}`] }],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'LOG_CONTENT_MISMATCH' }),
    );
  });

  it('orphans a log at the right index whose data no longer matches', async () => {
    // The amount lives in the data field, so this is the case where a source
    // record points at a real position and a real event type but a different
    // value than the ledger row was written from.
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        status: 1,
        logs: [{ ...LOG, data: '0x02' }],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'LOG_CONTENT_MISMATCH' }),
    );
  });

  it('reports UNVERIFIED when the entry stored a position but no content identity', async () => {
    const verdict = await verifierFor().verify(
      { ...ENTRY, logAddress: null, logIdentityHash: null },
      STABLE_BLOCK,
    );

    expect(verdict.state).toBe('UNVERIFIED');
  });

  it('treats hex case as spelling, not as a different log', async () => {
    const verdict = await verifierFor({
      getTransactionReceipt: async () => ({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        status: 1,
        logs: [
          {
            ...LOG,
            address: LOG_ADDRESS.toUpperCase().replace('0X', '0x'),
            topics: [TOPIC.toUpperCase().replace('0X', '0x')],
            data: '0X01',
          },
        ],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict.state).toBe('CANONICAL');
  });

  it('resolves the log identity an ingestion run stores, and memoizes the receipt', async () => {
    const getTransactionReceipt = jest.fn(async () => ({
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      status: 1,
      logs: [LOG],
    }));
    const verifier = verifierFor({ getTransactionReceipt });

    expect(await verifier.resolveLogIdentity('0xtx', 2)).toEqual({
      address: LOG_ADDRESS,
      identityHash: LOG_IDENTITY_HASH,
    });
    // A second component from the same transaction must not cost a second call.
    await verifier.resolveLogIdentity('0xtx', 2);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);

    expect(await verifier.resolveLogIdentity('0xtx', 9)).toBeNull();
  });

  it('normalizes a contract address and rejects anything that is not one', () => {
    expect(normalizeLogAddress(LOG_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe(LOG_ADDRESS);
    expect(normalizeLogAddress('0xnope')).toBeNull();
    expect(normalizeLogAddress(null)).toBeNull();
  });
});

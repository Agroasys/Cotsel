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
  normalizeBlockHash,
  type SettlementChainReader,
} from '../src/core/chainCanonicality';

const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const ENTRY = { txHash: '0xtx', blockNumber: 100, blockHash: BLOCK_HASH, logIndex: 2 };
const STABLE_BLOCK = 150;

function reader(overrides: Partial<SettlementChainReader>): SettlementChainReader {
  return {
    async getBlock() {
      return { number: STABLE_BLOCK, hash: BLOCK_HASH };
    },
    async getTransactionReceipt() {
      return { blockNumber: 100, blockHash: BLOCK_HASH, status: 1, logs: [{ index: 2 }] };
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
        logs: [{ index: 2 }],
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
        logs: [{ index: 2 }],
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
        logs: [{ index: 2 }],
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
        logs: [{ index: 9 }],
      }),
    }).verify(ENTRY, STABLE_BLOCK);

    expect(verdict).toEqual(
      expect.objectContaining({ state: 'ORPHANED', reason: 'LOG_IDENTITY_MISMATCH' }),
    );
  });

  it('reports UNVERIFIED rather than ORPHANED when the entry has no stored identity', async () => {
    const verdict = await verifierFor().verify(
      { ...ENTRY, blockHash: null, logIndex: null },
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
});

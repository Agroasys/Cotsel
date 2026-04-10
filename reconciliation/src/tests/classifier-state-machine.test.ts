import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeStatus, type Trade } from '@agroasys/sdk';
import { classifyDrifts } from '../core/classifier';
import type { IndexedTradeRecord } from '../types';

function baseIndexedTrade(): IndexedTradeRecord {
  return {
    tradeId: '1',
    buyer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    supplier: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    status: 'LOCKED',
    totalAmountLocked: 1000n,
    logisticsAmount: 100n,
    platformFeesAmount: 50n,
    supplierFirstTranche: 350n,
    supplierSecondTranche: 500n,
    ricardianHash: '0x' + '11'.repeat(32),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    arrivalTimestamp: null,
  };
}

function baseOnchainTrade(): Trade {
  return {
    tradeId: '1',
    buyer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    supplier: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    status: TradeStatus.LOCKED,
    totalAmountLocked: 1000n,
    logisticsAmount: 100n,
    platformFeesAmount: 50n,
    supplierFirstTranche: 350n,
    supplierSecondTranche: 500n,
    ricardianHash: '0x' + '11'.repeat(32),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    arrivalTimestamp: undefined,
  };
}

test('on-chain read failures produce a single deterministic critical finding', () => {
  const findings = classifyDrifts({
    indexedTrade: baseIndexedTrade(),
    onchainTrade: null,
    onchainReadError: 'timeout while fetching trade',
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].mismatchCode, 'ONCHAIN_READ_ERROR');
  assert.equal(findings[0].severity, 'CRITICAL');
  assert.equal(findings[0].comparedField, 'tradeLookup');
});

test('hash mismatch is classified as critical and stable across repeated runs', () => {
  const indexed = baseIndexedTrade();
  indexed.ricardianHash = '0x' + 'aa'.repeat(32);

  const onchain = baseOnchainTrade();
  onchain.ricardianHash = '0x' + 'bb'.repeat(32);

  const first = classifyDrifts({
    indexedTrade: indexed,
    onchainTrade: onchain,
  });

  const second = classifyDrifts({
    indexedTrade: indexed,
    onchainTrade: onchain,
  });

  assert.deepEqual(
    first,
    second,
    'expected deterministic finding order and payload across repeated classification',
  );
  assert.ok(
    first.some(
      (finding) => finding.mismatchCode === 'HASH_MISMATCH' && finding.severity === 'CRITICAL',
    ),
  );
});

test('amount mismatch remains critical and field-specific', () => {
  const indexed = baseIndexedTrade();
  indexed.totalAmountLocked = 1001n;

  const findings = classifyDrifts({
    indexedTrade: indexed,
    onchainTrade: baseOnchainTrade(),
  });

  const amountFinding = findings.find((finding) => finding.mismatchCode === 'AMOUNT_MISMATCH');
  assert.ok(amountFinding, 'expected AMOUNT_MISMATCH');
  assert.equal(amountFinding?.severity, 'CRITICAL');
  assert.equal(amountFinding?.comparedField, 'totalAmountLocked');
});

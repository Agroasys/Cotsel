import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { TradeStatus, type Trade } from '@agroasys/sdk';
import { classifyDrifts } from '../core/classifier';
import type { IndexedTradeRecord } from '../types';

type ProviderWithResolveName = typeof ethers.JsonRpcProvider.prototype & {
  resolveName: (name: string) => Promise<string | null>;
};

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

test('invalid indexed address is classified explicitly and does not invoke provider ENS resolution', () => {
  const providerPrototype = ethers.JsonRpcProvider.prototype as ProviderWithResolveName;
  const originalResolveName = providerPrototype.resolveName;
  let resolveNameCalled = false;

  providerPrototype.resolveName = async () => {
    resolveNameCalled = true;
    return null;
  };

  try {
    const indexedTrade = baseIndexedTrade();
    indexedTrade.buyer = 'not-an-address';

    const findings = classifyDrifts({
      indexedTrade,
      onchainTrade: baseOnchainTrade(),
    });

    assert.ok(
      findings.some(
        (finding) =>
          finding.mismatchCode === 'INDEXED_INVALID_ADDRESS' && finding.comparedField === 'buyer',
      ),
      'expected INDEXED_INVALID_ADDRESS finding for buyer field',
    );
    assert.equal(resolveNameCalled, false, 'classifier should not trigger ENS resolution');
  } finally {
    providerPrototype.resolveName = originalResolveName;
  }
});

test('lowercase and checksum addresses are normalized as equal (no participant mismatch)', () => {
  const indexedTrade = baseIndexedTrade();
  indexedTrade.buyer = indexedTrade.buyer.toLowerCase();
  indexedTrade.supplier = indexedTrade.supplier.toLowerCase();

  const findings = classifyDrifts({
    indexedTrade,
    onchainTrade: baseOnchainTrade(),
  });

  assert.equal(
    findings.some((finding) => finding.mismatchCode === 'PARTICIPANT_MISMATCH'),
    false,
    'expected no participant mismatch for equivalent lowercase/checksum addresses',
  );
  assert.equal(
    findings.some((finding) => finding.mismatchCode === 'INDEXED_INVALID_ADDRESS'),
    false,
    'expected no invalid-address finding for valid lowercase addresses',
  );
});

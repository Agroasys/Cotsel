import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUALIFYING_DISCREPANCY_CODES,
  buildContainmentEvidence,
  generateIncidentReference,
  isQualifyingDiscrepancy,
  qualifyDiscrepancies,
} from '../core/containment';
import type { DriftCode, DriftFinding, DriftSeverity } from '../types';

function finding(
  tradeId: string,
  mismatchCode: DriftCode,
  severity: DriftSeverity = 'CRITICAL',
): DriftFinding {
  return {
    tradeId,
    severity,
    mismatchCode,
    comparedField: 'totalAmountLocked',
    onchainValue: '100',
    indexedValue: '101',
    details: {},
  };
}

test('a divergence in money, parties, or agreement identity qualifies for containment', () => {
  for (const code of [
    'AMOUNT_MISMATCH',
    'FEE_COMPONENT_MISMATCH',
    'PARTICIPANT_MISMATCH',
    'HASH_MISMATCH',
    'ONCHAIN_TRADE_MISSING',
    'INDEXER_TRADE_MISSING',
  ] as DriftCode[]) {
    assert.equal(isQualifyingDiscrepancy(finding('1', code)), true, `${code} should qualify`);
  }
});

test('an inconclusive read never contains a trade', () => {
  // A transient RPC failure is CRITICAL but says nothing about the trade.
  // Containing on it would pause healthy settlement every time an endpoint
  // hiccuped.
  assert.equal(isQualifyingDiscrepancy(finding('1', 'ONCHAIN_READ_ERROR')), false);
});

test('a whole-projection surplus cannot scope a pause to one trade', () => {
  assert.equal(isQualifyingDiscrepancy(finding('1', 'INDEXER_SURPLUS_RECORDS')), false);
});

test('lifecycle lag and unusable values do not qualify', () => {
  for (const code of [
    'STATUS_MISMATCH',
    'ARRIVAL_TIMESTAMP_MISMATCH',
    'INDEXED_INVALID_ADDRESS',
    'ONCHAIN_INVALID_ADDRESS',
  ] as DriftCode[]) {
    assert.equal(isQualifyingDiscrepancy(finding('1', code)), false, `${code} should not qualify`);
  }
});

test('the qualifying set stays a deliberate allow-list', () => {
  // Guards against a new drift code silently becoming a pause trigger: adding
  // one must be a decision recorded here, not a side effect.
  assert.deepEqual([...QUALIFYING_DISCREPANCY_CODES].sort(), [
    'AMOUNT_MISMATCH',
    'FEE_COMPONENT_MISMATCH',
    'HASH_MISMATCH',
    'INDEXER_TRADE_MISSING',
    'ONCHAIN_TRADE_MISSING',
    'PARTICIPANT_MISMATCH',
  ]);
});

test('containment is scoped to the affected trades only', () => {
  const qualified = qualifyDiscrepancies([
    finding('7', 'AMOUNT_MISMATCH'),
    finding('8', 'STATUS_MISMATCH', 'HIGH'),
    finding('9', 'ONCHAIN_READ_ERROR'),
  ]);

  assert.deepEqual(
    qualified.map((entry) => entry.tradeId),
    ['7'],
  );
});

test('several qualifying findings on one trade open a single incident', () => {
  const qualified = qualifyDiscrepancies([
    finding('7', 'AMOUNT_MISMATCH'),
    finding('7', 'PARTICIPANT_MISMATCH'),
    finding('7', 'AMOUNT_MISMATCH'),
  ]);

  assert.equal(qualified.length, 1);
  assert.deepEqual(qualified[0].codes, ['AMOUNT_MISMATCH', 'PARTICIPANT_MISMATCH']);
  assert.equal(qualified[0].findings.length, 3);
});

test('an incident reference is dated, unique, and fits the reference column', () => {
  const first = generateIncidentReference(new Date('2026-09-12T23:30:00Z'));
  const second = generateIncidentReference(new Date('2026-09-12T23:30:00Z'));

  assert.match(first, /^RECON-20260912-[0-9A-F]{8}$/u);
  assert.notEqual(first, second);
  assert.ok(first.length <= 64);
});

test('an incident reference uses UTC, not the host time zone', () => {
  // A run just before midnight UTC must not be filed under the next day
  // because the machine happens to be east of Greenwich.
  assert.match(generateIncidentReference(new Date('2026-01-01T00:30:00Z')), /^RECON-20260101-/u);
});

test('incident evidence preserves the findings and the block they were read at', () => {
  const discrepancy = qualifyDiscrepancies([finding('7', 'AMOUNT_MISMATCH')])[0];
  const evidence = buildContainmentEvidence({
    runKey: 'daemon-1',
    boundaryBlock: 4242,
    boundaryBlockHash: '0xabc',
    discrepancy,
  });

  assert.deepEqual(evidence, {
    runKey: 'daemon-1',
    boundaryBlock: 4242,
    boundaryBlockHash: '0xabc',
    findings: [
      {
        mismatchCode: 'AMOUNT_MISMATCH',
        comparedField: 'totalAmountLocked',
        severity: 'CRITICAL',
        onchainValue: '100',
        indexedValue: '101',
        details: {},
      },
    ],
  });
});

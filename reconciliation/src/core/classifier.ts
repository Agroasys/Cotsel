import { TradeStatus, type Trade } from '@agroasys/sdk';
import type { CompareInput, DriftFinding } from '../types';
import { isZeroAddress, normalizeAddressOrNull } from '../utils/address';

function statusLabel(status: TradeStatus): string {
  switch (status) {
    case TradeStatus.LOCKED:
      return 'LOCKED';
    case TradeStatus.IN_TRANSIT:
      return 'IN_TRANSIT';
    case TradeStatus.ARRIVAL_CONFIRMED:
      return 'ARRIVAL_CONFIRMED';
    case TradeStatus.FROZEN:
      return 'FROZEN';
    case TradeStatus.CLOSED:
      return 'CLOSED';
    default:
      return `UNKNOWN_${status}`;
  }
}

function bigintToString(value: bigint): string {
  return value.toString();
}

function compareAmounts(indexed: CompareInput['indexedTrade'], onchain: Trade): DriftFinding[] {
  const mismatches: DriftFinding[] = [];

  const amountFields: Array<{
    field: keyof Pick<
      Trade,
      | 'totalAmountLocked'
      | 'logisticsAmount'
      | 'platformFeesAmount'
      | 'supplierFirstTranche'
      | 'supplierSecondTranche'
    >;
    indexedValue: bigint;
  }> = [
    { field: 'totalAmountLocked', indexedValue: indexed.totalAmountLocked },
    { field: 'logisticsAmount', indexedValue: indexed.logisticsAmount },
    { field: 'platformFeesAmount', indexedValue: indexed.platformFeesAmount },
    { field: 'supplierFirstTranche', indexedValue: indexed.supplierFirstTranche },
    { field: 'supplierSecondTranche', indexedValue: indexed.supplierSecondTranche },
  ];

  for (const field of amountFields) {
    const onchainValue = onchain[field.field];
    if (onchainValue !== field.indexedValue) {
      mismatches.push({
        tradeId: indexed.tradeId,
        severity: 'CRITICAL',
        mismatchCode: 'AMOUNT_MISMATCH',
        comparedField: field.field,
        onchainValue: bigintToString(onchainValue),
        indexedValue: bigintToString(field.indexedValue),
        details: {
          field: field.field,
          impact: 'financial',
        },
      });
    }
  }

  return mismatches;
}

function invalidAddressFinding(
  tradeId: string,
  source: 'indexed' | 'onchain',
  field: 'buyer' | 'supplier',
  value: string,
): DriftFinding {
  return {
    tradeId,
    severity: 'CRITICAL',
    mismatchCode: source === 'indexed' ? 'INDEXED_INVALID_ADDRESS' : 'ONCHAIN_INVALID_ADDRESS',
    comparedField: field,
    onchainValue: source === 'onchain' ? value : null,
    indexedValue: source === 'indexed' ? value : null,
    details: {
      source,
      field,
      reason: 'address is not a valid hex EVM address',
    },
  };
}

export function classifyDrifts(input: CompareInput): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const { indexedTrade, onchainTrade, onchainReadError } = input;

  if (onchainReadError) {
    return [
      {
        tradeId: indexedTrade.tradeId,
        severity: 'CRITICAL',
        mismatchCode: 'ONCHAIN_READ_ERROR',
        comparedField: 'tradeLookup',
        onchainValue: null,
        indexedValue: indexedTrade.status,
        details: {
          error: onchainReadError,
        },
      },
    ];
  }

  if (!onchainTrade || isZeroAddress(onchainTrade.buyer)) {
    return [
      {
        tradeId: indexedTrade.tradeId,
        severity: 'CRITICAL',
        mismatchCode: 'ONCHAIN_TRADE_MISSING',
        comparedField: 'tradePresence',
        onchainValue: null,
        indexedValue: indexedTrade.tradeId,
        details: {
          reason: 'trade not found on-chain',
        },
      },
    ];
  }

  const onchainStatus = statusLabel(onchainTrade.status);
  if (onchainStatus !== indexedTrade.status) {
    findings.push({
      tradeId: indexedTrade.tradeId,
      severity: 'HIGH',
      mismatchCode: 'STATUS_MISMATCH',
      comparedField: 'status',
      onchainValue: onchainStatus,
      indexedValue: indexedTrade.status,
      details: {
        impact: 'workflow divergence',
      },
    });
  }

  const indexedBuyer = normalizeAddressOrNull(indexedTrade.buyer);
  if (!indexedBuyer) {
    findings.push(
      invalidAddressFinding(indexedTrade.tradeId, 'indexed', 'buyer', indexedTrade.buyer),
    );
  }

  const indexedSupplier = normalizeAddressOrNull(indexedTrade.supplier);
  if (!indexedSupplier) {
    findings.push(
      invalidAddressFinding(indexedTrade.tradeId, 'indexed', 'supplier', indexedTrade.supplier),
    );
  }

  const onchainBuyer = normalizeAddressOrNull(onchainTrade.buyer);
  if (!onchainBuyer) {
    findings.push(
      invalidAddressFinding(indexedTrade.tradeId, 'onchain', 'buyer', onchainTrade.buyer),
    );
  }

  const onchainSupplier = normalizeAddressOrNull(onchainTrade.supplier);
  if (!onchainSupplier) {
    findings.push(
      invalidAddressFinding(indexedTrade.tradeId, 'onchain', 'supplier', onchainTrade.supplier),
    );
  }

  if (indexedBuyer && onchainBuyer && onchainBuyer !== indexedBuyer) {
    findings.push({
      tradeId: indexedTrade.tradeId,
      severity: 'CRITICAL',
      mismatchCode: 'PARTICIPANT_MISMATCH',
      comparedField: 'buyer',
      onchainValue: onchainTrade.buyer,
      indexedValue: indexedTrade.buyer,
      details: {
        field: 'buyer',
      },
    });
  }

  if (indexedSupplier && onchainSupplier && onchainSupplier !== indexedSupplier) {
    findings.push({
      tradeId: indexedTrade.tradeId,
      severity: 'CRITICAL',
      mismatchCode: 'PARTICIPANT_MISMATCH',
      comparedField: 'supplier',
      onchainValue: onchainTrade.supplier,
      indexedValue: indexedTrade.supplier,
      details: {
        field: 'supplier',
      },
    });
  }

  findings.push(...compareAmounts(indexedTrade, onchainTrade));

  if (onchainTrade.ricardianHash.toLowerCase() !== indexedTrade.ricardianHash.toLowerCase()) {
    findings.push({
      tradeId: indexedTrade.tradeId,
      severity: 'CRITICAL',
      mismatchCode: 'HASH_MISMATCH',
      comparedField: 'ricardianHash',
      onchainValue: onchainTrade.ricardianHash,
      indexedValue: indexedTrade.ricardianHash,
      details: {
        impact: 'legal linkage divergence',
      },
    });
  }

  const onchainArrivalIso = onchainTrade.arrivalTimestamp
    ? onchainTrade.arrivalTimestamp.toISOString()
    : null;
  const indexedArrivalIso = indexedTrade.arrivalTimestamp
    ? indexedTrade.arrivalTimestamp.toISOString()
    : null;

  if (onchainArrivalIso !== indexedArrivalIso) {
    findings.push({
      tradeId: indexedTrade.tradeId,
      severity: 'MEDIUM',
      mismatchCode: 'ARRIVAL_TIMESTAMP_MISMATCH',
      comparedField: 'arrivalTimestamp',
      onchainValue: onchainArrivalIso,
      indexedValue: indexedArrivalIso,
      details: {
        impact: 'timeline divergence',
      },
    });
  }

  return findings;
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT = 'reports/gasless-relayer-capacity/latest.json';
const DEFAULT_TARGET_TX_PER_DAY = 500;
const DEFAULT_TARGET_NOTIONAL_USD = 10_000_000;
const DEFAULT_BURST_MULTIPLIER = 4;
const DEFAULT_GAS_LIMIT_CAP = 1_500_000n;
const DEFAULT_MAX_FEE_PER_GAS_WEI = 50_000_000_000n;
const DEFAULT_MAX_NATIVE_COST_WEI = 100_000_000_000_000_000n;
const DEFAULT_SAFETY_MARGIN_BASIS_POINTS = 12_500;

function usage() {
  console.error(`Usage: node scripts/gasless-relayer-capacity-rehearsal.mjs [options]

Options:
  --mode <config-only|live>      Rehearsal mode. Default: config-only
  --output <path>                JSON output path. Default: ${DEFAULT_OUTPUT}
  --evidence-file <path>         Required in live mode. Populated Base Sepolia proof summary JSON
  --stdout                       Also print report JSON to stdout
`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    mode: 'config-only',
    output: DEFAULT_OUTPUT,
    evidenceFile: null,
    stdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--mode':
        options.mode = requireValue(argv, ++index, arg);
        if (!['config-only', 'live'].includes(options.mode)) {
          throw new Error('--mode must be config-only or live');
        }
        break;
      case '--output':
        options.output = requireValue(argv, ++index, arg);
        break;
      case '--evidence-file':
        options.evidenceFile = requireValue(argv, ++index, arg);
        break;
      case '--stdout':
        options.stdout = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function envNumber(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function envBigInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(raw);
}

function envBool(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function envPositiveInteger(name, fallback) {
  const value = envNumber(name, fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseUrlList(raw) {
  return (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

const FAILURE_MODE_EVIDENCE_REQUIREMENTS = {
  relayerOutageOrDisabled: {
    scenario: 'relayer_outage_or_disabled',
    requiredChecks: ['readinessCaptured', 'broadcastPausedOrDisabled', 'noUserEthRequired'],
  },
  fallbackUx: {
    scenario: 'fallback_ux',
    requiredChecks: ['fallbackPresented', 'operatorRecoveryPathCaptured', 'noUserEthRequired'],
  },
  operatorFailureRehearsal: {
    scenario: 'operator_failure_rehearsal',
    requiredChecks: ['readinessCaptured'],
    anyChecks: [
      'stuckQueueAlertVisible',
      'repeatedFailureAlertVisible',
      'droppedExecutionCaptured',
    ],
  },
};

function hasValidTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function evidencePacketPasses(packet, requirement) {
  if (!packet || typeof packet !== 'object') {
    return false;
  }
  const checks = packet.checks && typeof packet.checks === 'object' ? packet.checks : {};
  const requiredChecksPass = requirement.requiredChecks.every((key) => checks[key] === true);
  const anyChecksPass = requirement.anyChecks
    ? requirement.anyChecks.some((key) => checks[key] === true)
    : true;
  return (
    packet.status === 'passed' &&
    packet.scenario === requirement.scenario &&
    hasNonEmptyString(packet.evidenceRef) &&
    hasValidTimestamp(packet.observedAt) &&
    requiredChecksPass &&
    anyChecksPass
  );
}

function buildCapacityReport(options, now = new Date()) {
  const targetTransactionsPerDay = envPositiveInteger(
    'GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY',
    DEFAULT_TARGET_TX_PER_DAY,
  );
  const targetNotionalUsd = envNumber(
    'GATEWAY_GASLESS_CAPACITY_TARGET_NOTIONAL_USD',
    DEFAULT_TARGET_NOTIONAL_USD,
  );
  const burstMultiplier = envNumber(
    'GATEWAY_GASLESS_CAPACITY_BURST_MULTIPLIER',
    DEFAULT_BURST_MULTIPLIER,
  );
  const burstMultiplierBasisPoints = envPositiveInteger(
    'GATEWAY_GASLESS_CAPACITY_BURST_MULTIPLIER_BASIS_POINTS',
    Math.ceil(burstMultiplier * 10_000),
  );
  const safetyMarginBasisPoints = envPositiveInteger(
    'GATEWAY_GASLESS_CAPACITY_SAFETY_MARGIN_BASIS_POINTS',
    DEFAULT_SAFETY_MARGIN_BASIS_POINTS,
  );
  if (safetyMarginBasisPoints < 10_000) {
    throw new Error('GATEWAY_GASLESS_CAPACITY_SAFETY_MARGIN_BASIS_POINTS must be >= 10000');
  }
  const gasLimitCap = envBigInt('GATEWAY_GASLESS_MAX_GAS_LIMIT', DEFAULT_GAS_LIMIT_CAP);
  const maxFeePerGasWei = envBigInt(
    'GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI',
    DEFAULT_MAX_FEE_PER_GAS_WEI,
  );
  const maxNativeCostWei = envBigInt(
    'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI',
    DEFAULT_MAX_NATIVE_COST_WEI,
  );
  const minExecutorBalanceWei = envBigInt('GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI', 0n);
  const lowBalanceAlertWei = envBigInt('GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI', 0n);
  const requireFallback = envBool('GATEWAY_GASLESS_REQUIRE_RPC_FALLBACK', options.mode === 'live');
  const failClosedCapacity = envBool(
    'GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED',
    process.env.NODE_ENV === 'production' || process.env.GATEWAY_CHAIN_ID === '8453',
  );
  const fallbackUrls = parseUrlList(process.env.GATEWAY_RPC_FALLBACK_URLS);
  const signerCustodyMode = (process.env.GATEWAY_GASLESS_SIGNER_CUSTODY_MODE || 'raw_private_key')
    .trim()
    .toLowerCase();
  const allowRawPrivateKeyInProduction = envBool(
    'GATEWAY_GASLESS_ALLOW_RAW_PRIVATE_KEY_IN_PRODUCTION',
    false,
  );
  const managedSignerUrl = (process.env.GATEWAY_GASLESS_MANAGED_SIGNER_URL || '').trim();
  const managedSignerApiKey = (process.env.GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY || '').trim();
  const rawGaslessExecutorKeyConfigured = Boolean(
    (process.env.GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY || '').trim() ||
    (process.env.GATEWAY_EXECUTOR_PRIVATE_KEY || '').trim(),
  );
  const productionLike =
    process.env.NODE_ENV === 'production' || process.env.GATEWAY_CHAIN_ID === '8453';

  const averageTransactionsPerHour = Math.ceil(targetTransactionsPerDay / 24);
  const burstTransactionsPerHour = Number(
    ceilDiv(BigInt(targetTransactionsPerDay) * BigInt(burstMultiplierBasisPoints), 24n * 10_000n),
  );
  const maxCostPerTxWei = gasLimitCap * maxFeePerGasWei;
  const requiredBurstHourBalanceWei = ceilDiv(
    maxCostPerTxWei * BigInt(burstTransactionsPerHour) * BigInt(safetyMarginBasisPoints),
    10_000n,
  );
  const projectedDailyMaxCostWei = maxCostPerTxWei * BigInt(targetTransactionsPerDay);
  const blockers = [];
  const warnings = [];

  if (targetTransactionsPerDay < DEFAULT_TARGET_TX_PER_DAY) {
    blockers.push('capacity target is below 500 transactions/day');
  }
  if (targetNotionalUsd < DEFAULT_TARGET_NOTIONAL_USD) {
    blockers.push('notional target is below $10M/day');
  }
  if (maxCostPerTxWei > maxNativeCostWei) {
    blockers.push('per-transaction gas cap can exceed GATEWAY_GASLESS_MAX_NATIVE_COST_WEI');
  }
  if (requireFallback && fallbackUrls.length === 0) {
    blockers.push('managed fallback RPC is required for live gasless rehearsal');
  }
  if (!['raw_private_key', 'kms', 'mpc'].includes(signerCustodyMode)) {
    blockers.push('GATEWAY_GASLESS_SIGNER_CUSTODY_MODE must be raw_private_key, kms, or mpc');
  }
  if (
    signerCustodyMode === 'raw_private_key' &&
    productionLike &&
    !allowRawPrivateKeyInProduction
  ) {
    blockers.push('production gasless custody must use kms/mpc or an approved raw-key exception');
  }
  if ((signerCustodyMode === 'kms' || signerCustodyMode === 'mpc') && !managedSignerUrl) {
    blockers.push('managed gasless custody requires GATEWAY_GASLESS_MANAGED_SIGNER_URL');
  }
  if (
    (signerCustodyMode === 'kms' || signerCustodyMode === 'mpc') &&
    rawGaslessExecutorKeyConfigured
  ) {
    blockers.push('managed gasless custody must not configure a raw executor private key');
  }
  if (
    (signerCustodyMode === 'kms' || signerCustodyMode === 'mpc') &&
    productionLike &&
    !managedSignerUrl.startsWith('https://')
  ) {
    blockers.push('production managed gasless custody requires an https managed signer URL');
  }
  if (
    (signerCustodyMode === 'kms' || signerCustodyMode === 'mpc') &&
    productionLike &&
    !managedSignerApiKey
  ) {
    blockers.push('production managed gasless custody requires a managed signer API key');
  }
  if (
    lowBalanceAlertWei > 0n &&
    minExecutorBalanceWei > 0n &&
    lowBalanceAlertWei < minExecutorBalanceWei
  ) {
    blockers.push('low-balance alert threshold is below the minimum executor balance floor');
  }
  if (minExecutorBalanceWei < requiredBurstHourBalanceWei) {
    const message =
      'executor balance floor does not cover the configured burst-hour capacity policy';
    if (failClosedCapacity) {
      blockers.push(message);
    } else {
      warnings.push(message);
    }
  }
  if (lowBalanceAlertWei < requiredBurstHourBalanceWei) {
    const message =
      'low-balance alert threshold does not cover the configured burst-hour capacity policy';
    if (failClosedCapacity) {
      blockers.push(message);
    } else {
      warnings.push(message);
    }
  }

  let evidence = { required: options.mode === 'live', present: false, path: options.evidenceFile };
  if (options.mode === 'live') {
    if (!options.evidenceFile) {
      blockers.push('live mode requires --evidence-file with populated Base Sepolia proof summary');
    } else if (!fs.existsSync(options.evidenceFile)) {
      blockers.push(`live evidence file is missing: ${options.evidenceFile}`);
    } else {
      const parsed = JSON.parse(fs.readFileSync(options.evidenceFile, 'utf8'));
      const transactionKeys = [
        'createTradeGasless',
        'stage1Release',
        'confirmArrival',
        'openDisputeGasless',
        'proposeRefund',
        'approveRefund',
      ];
      const transactions = parsed.transactions ?? {};
      const missingTransactions = transactionKeys.filter((key) => !transactions[key]);
      const nonRefundableFeesMatch =
        parsed.currentRunEvidence?.nonRefundableFeesAddedToTreasury &&
        parsed.currentRunEvidence?.expectedNonRefundableFees &&
        parsed.currentRunEvidence.nonRefundableFeesAddedToTreasury ===
          parsed.currentRunEvidence.expectedNonRefundableFees;
      const supplierPayoutDeltaMatches =
        parsed.currentRunEvidence?.balanceDeltas?.supplierUsdc &&
        parsed.trade?.supplierFirstTranche &&
        parsed.currentRunEvidence.balanceDeltas.supplierUsdc === parsed.trade.supplierFirstTranche;
      const buyerNetDeltaMatches =
        parsed.currentRunEvidence?.balanceDeltas?.buyerUsdc &&
        parsed.trade?.totalAmount &&
        parsed.trade?.supplierSecondTranche &&
        parsed.currentRunEvidence.balanceDeltas.buyerUsdc ===
          `-${BigInt(parsed.trade.totalAmount) - BigInt(parsed.trade.supplierSecondTranche)}`;
      const servicePaidGas =
        parsed.currentRunEvidence?.balanceDeltas?.serviceEthWei &&
        BigInt(parsed.currentRunEvidence.balanceDeltas.serviceEthWei) < 0n;
      const hasBackendAccounting = (parsed.backendEvidence?.accounting?.length ?? 0) > 0;
      const hasGatewayReconciledRefund = (parsed.gateway?.refundEvents ?? []).some(
        (event) =>
          event.eventType === 'reconciled' &&
          event.executionStatus === 'confirmed' &&
          event.reconciliationStatus === 'matched' &&
          Boolean(event.txHash),
      );
      const hasDeliveredReconciledCallback = (
        parsed.gatewayEvidence?.callbackDeliveries ?? []
      ).some(
        (delivery) =>
          delivery.eventType === 'reconciled' &&
          delivery.reconciliationStatus === 'matched' &&
          delivery.status === 'delivered' &&
          delivery.deliveredAt,
      );
      const hasBackendReconciledRefund = (parsed.backendEvidence?.refundEvents ?? []).some(
        (event) =>
          event.eventType === 'execution_reconciled' &&
          event.sourceSystem === 'reconciler' &&
          Boolean(event.externalTransactionHash) &&
          event.observedBuyerRefundCents !== null &&
          event.observedBuyerRefundCents !== undefined,
      );
      const failureModeEvidence = parsed.failureModeEvidence ?? {};
      const expiredAuthorizationProven =
        failureModeEvidence.expiredAuthorization?.passed === true &&
        failureModeEvidence.expiredAuthorization?.noTradeCreated === true;
      const idempotentReplayProven =
        failureModeEvidence.idempotentReplay?.passed === true &&
        failureModeEvidence.idempotentReplay?.noDuplicateTradeCreated === true;
      const relayerOutageEvidencePresent = evidencePacketPasses(
        failureModeEvidence.relayerOutageOrDisabled,
        FAILURE_MODE_EVIDENCE_REQUIREMENTS.relayerOutageOrDisabled,
      );
      const fallbackUxEvidencePresent = evidencePacketPasses(
        failureModeEvidence.fallbackUx,
        FAILURE_MODE_EVIDENCE_REQUIREMENTS.fallbackUx,
      );
      const operatorFailureRehearsalEvidencePresent = evidencePacketPasses(
        failureModeEvidence.operatorFailureRehearsal,
        FAILURE_MODE_EVIDENCE_REQUIREMENTS.operatorFailureRehearsal,
      );
      if (missingTransactions.length > 0) {
        blockers.push(
          `live evidence is missing required transaction hashes: ${missingTransactions.join(', ')}`,
        );
      }
      if (!nonRefundableFeesMatch) {
        blockers.push(
          'live evidence does not prove non-refundable fee accrual matches expected fees',
        );
      }
      if (!supplierPayoutDeltaMatches) {
        blockers.push('live evidence does not prove the direct supplier payout delta');
      }
      if (!buyerNetDeltaMatches) {
        blockers.push('live evidence does not prove the direct buyer refund net delta');
      }
      if (!servicePaidGas) {
        blockers.push('live evidence does not prove service-wallet gas payment');
      }
      if (!hasBackendAccounting) {
        blockers.push('live evidence does not include backend sponsorship accounting rows');
      }
      if (!hasGatewayReconciledRefund) {
        blockers.push(
          'live evidence does not include a matched gateway refund reconciliation event',
        );
      }
      if (!hasDeliveredReconciledCallback) {
        blockers.push('live evidence does not include delivered callback evidence');
      }
      if (!hasBackendReconciledRefund) {
        blockers.push('live evidence does not include a matched backend refund ledger event');
      }
      if (!expiredAuthorizationProven) {
        blockers.push(
          'live evidence does not prove expired gasless authorization rejection with no trade created',
        );
      }
      if (!idempotentReplayProven) {
        blockers.push(
          'live evidence does not prove idempotent replay returned the original result without a duplicate trade',
        );
      }
      if (!relayerOutageEvidencePresent) {
        blockers.push(
          'live evidence does not include relayer outage or disabled-relayer rehearsal evidence',
        );
      }
      if (!fallbackUxEvidencePresent) {
        blockers.push('live evidence does not include fallback UX/operator recovery evidence');
      }
      if (!operatorFailureRehearsalEvidencePresent) {
        blockers.push(
          'live evidence does not include operator failure rehearsal evidence for dropped or stuck execution',
        );
      }
      evidence = {
        ...evidence,
        present: true,
        type: parsed.transactions ? 'live-base-sepolia-proof' : 'summary',
        status: parsed.status ?? parsed.result ?? 'provided',
        transactionCount: Object.values(transactions).filter(Boolean).length,
        backendAccountingEntries: parsed.backendEvidence?.accounting?.length ?? null,
        backendRefundEvents: parsed.backendEvidence?.refundEvents?.length ?? null,
        gatewayRefundEvents: parsed.gateway?.refundEvents?.length ?? null,
        gatewayCallbackDeliveries: parsed.gatewayEvidence?.callbackDeliveries?.length ?? null,
        failureModes: {
          expiredAuthorization: expiredAuthorizationProven,
          idempotentReplay: idempotentReplayProven,
          relayerOutageOrDisabled: relayerOutageEvidencePresent,
          fallbackUx: fallbackUxEvidencePresent,
          operatorFailureRehearsal: operatorFailureRehearsalEvidencePresent,
        },
      };
    }
  }

  return {
    status: blockers.length === 0 ? 'pass' : 'fail',
    mode: options.mode,
    generatedAt: now.toISOString(),
    targets: {
      transactionsPerDay: targetTransactionsPerDay,
      notionalUsdPerDay: targetNotionalUsd,
      burstMultiplier,
      burstMultiplierBasisPoints,
      safetyMarginBasisPoints,
      averageTransactionsPerHour,
      burstTransactionsPerHour,
    },
    actionMix: {
      createTrade: 0.5,
      directSupplierPayout: 0.3,
      directBuyerRefundOrDisputeEdge: 0.15,
      operatorRecovery: 0.05,
    },
    controls: {
      gasLimitCap: gasLimitCap.toString(),
      maxFeePerGasWei: maxFeePerGasWei.toString(),
      maxNativeCostWei: maxNativeCostWei.toString(),
      maxCostPerTxWei: maxCostPerTxWei.toString(),
      requiredBurstHourBalanceWei: requiredBurstHourBalanceWei.toString(),
      projectedDailyMaxCostWei: projectedDailyMaxCostWei.toString(),
      minExecutorBalanceWei: minExecutorBalanceWei.toString(),
      lowBalanceAlertWei: lowBalanceAlertWei.toString(),
      fallbackRpcCount: fallbackUrls.length,
      requireFallback,
      failClosedCapacity,
      signerCustodyMode,
      managedSignerConfigured: Boolean(managedSignerUrl),
      managedSignerApiKeyConfigured: Boolean(managedSignerApiKey),
    },
    evidence,
    blockers,
    warnings,
  };
}

function main() {
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const options = parseArgs(process.argv.slice(2));
  const report = buildCapacityReport(options);
  const outputPath = path.isAbsolute(options.output)
    ? options.output
    : path.join(rootDir, options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  if (options.stdout) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`gasless relayer capacity rehearsal: ${report.status}`);
    console.log(`report: ${path.relative(rootDir, outputPath)}`);
  }

  process.exit(report.status === 'pass' ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(1);
  }
}

export { buildCapacityReport, parseArgs };

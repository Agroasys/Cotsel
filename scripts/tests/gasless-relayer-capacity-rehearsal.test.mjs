import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCapacityReport, parseArgs } from '../gasless-relayer-capacity-rehearsal.mjs';

function withEnv(overrides, fn) {
  const snapshot = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    process.env = snapshot;
  }
}

test('gasless relayer capacity rehearsal passes coherent config-only controls', () => {
  withEnv(
    {
      GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
      GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
      GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '200000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '200000000000000000',
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'config-only', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'pass');
      assert.equal(report.targets.transactionsPerDay, 500);
      assert.equal(report.targets.notionalUsdPerDay, 10_000_000);
      assert.equal(report.controls.fallbackRpcCount, 1);
      assert.equal(report.controls.requiredBurstHourBalanceWei, '157500000000000000');
      assert.equal(report.blockers.length, 0);
      assert.equal(report.warnings.length, 0);
    },
  );
});

test('gasless relayer capacity warns outside fail-closed mode when burst-hour floor is underfunded', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      GATEWAY_CHAIN_ID: '84532',
      GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
      GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
      GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '100000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '150000000000000000',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'config-only', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'pass');
      assert.match(report.warnings.join('\n'), /burst-hour capacity policy/);
      assert.equal(report.blockers.length, 0);
    },
  );
});

test('gasless relayer capacity blocks in fail-closed mode when burst-hour floor is underfunded', () => {
  withEnv(
    {
      GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED: 'true',
      GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
      GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
      GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '100000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '150000000000000000',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'config-only', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.match(report.blockers.join('\n'), /burst-hour capacity policy/);
    },
  );
});

test('gasless relayer capacity rehearsal fails when low-balance alert is below hard floor', () => {
  withEnv(
    {
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '100000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '50000000000000000',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'config-only', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.match(report.blockers.join('\n'), /low-balance alert threshold is below/);
    },
  );
});

test('gasless relayer capacity rehearsal blocks raw-key custody for production-like chains', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      GATEWAY_CHAIN_ID: '8453',
      GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'raw_private_key',
      GATEWAY_GASLESS_ALLOW_RAW_PRIVATE_KEY_IN_PRODUCTION: 'false',
      GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
      GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
      GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '200000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '200000000000000000',
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'config-only', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.match(report.blockers.join('\n'), /production gasless custody must use kms\/mpc/);
    },
  );
});

test('gasless relayer capacity rehearsal blocks managed custody with raw executor key material', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      GATEWAY_CHAIN_ID: '84532',
      GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'kms',
      GATEWAY_GASLESS_MANAGED_SIGNER_URL: 'https://signer.example.test',
      GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY:
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      GATEWAY_EXECUTOR_PRIVATE_KEY: '',
      GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
      GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
      GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '200000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '200000000000000000',
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'config-only', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.match(report.blockers.join('\n'), /must not configure a raw executor private key/);
    },
  );
});

test('gasless relayer capacity rehearsal fails live mode without evidence and fallback', () => {
  withEnv(
    {
      GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
      GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
      GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
      GATEWAY_RPC_FALLBACK_URLS: '',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'live', output: 'unused.json', evidenceFile: null },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.match(report.blockers.join('\n'), /managed fallback RPC/);
      assert.match(report.blockers.join('\n'), /live mode requires --evidence-file/);
    },
  );
});

test('gasless relayer capacity parser rejects unknown modes', () => {
  assert.throws(() => parseArgs(['--mode', 'dry-run']), /--mode must be config-only or live/);
});

test('gasless relayer capacity parser accepts npm separator', () => {
  const parsed = parseArgs(['--', '--mode', 'config-only', '--stdout']);
  assert.equal(parsed.mode, 'config-only');
  assert.equal(parsed.stdout, true);
});

test('gasless relayer capacity live mode validates transaction proof content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasless-capacity-'));
  const evidenceFile = path.join(tmpDir, 'live-proof.json');
  fs.writeFileSync(
    evidenceFile,
    JSON.stringify({
      transactions: {
        createTradeGasless: '0xcreate',
        stage1Release: '0xstage1',
        confirmArrival: '0xarrival',
        openDisputeGasless: '0xdispute',
        proposeRefund: '0xproposal',
        approveRefund: '0xrefund',
      },
      failureModeEvidence: {
        expiredAuthorization: {
          passed: true,
          noTradeCreated: true,
        },
        idempotentReplay: {
          passed: true,
          noDuplicateTradeCreated: true,
        },
        relayerOutageOrDisabled: {
          scenario: 'relayer_outage_or_disabled',
          status: 'passed',
          observedAt: '2026-05-30T00:00:00.000Z',
          evidenceRef: 'reports/base-sepolia-pilot-validation/outage-rehearsal.json',
          checks: {
            readinessCaptured: true,
            broadcastPausedOrDisabled: true,
            noUserEthRequired: true,
          },
        },
        fallbackUx: {
          scenario: 'fallback_ux',
          status: 'passed',
          observedAt: '2026-05-30T00:00:00.000Z',
          evidenceRef: 'reports/base-sepolia-pilot-validation/fallback-ux-smoke.json',
          checks: {
            fallbackPresented: true,
            operatorRecoveryPathCaptured: true,
            noUserEthRequired: true,
          },
        },
        operatorFailureRehearsal: {
          scenario: 'operator_failure_rehearsal',
          status: 'passed',
          observedAt: '2026-05-30T00:00:00.000Z',
          evidenceRef: 'reports/base-sepolia-pilot-validation/stuck-execution-rehearsal.json',
          checks: {
            readinessCaptured: true,
            stuckQueueAlertVisible: true,
            repeatedFailureAlertVisible: false,
            droppedExecutionCaptured: false,
          },
        },
      },
      currentRunEvidence: {
        balanceDeltas: {
          buyerUsdc: '-7000000',
          supplierUsdc: '2000000',
          serviceEthWei: '-1000000000000',
        },
        nonRefundableFeesAddedToTreasury: '5000000',
        expectedNonRefundableFees: '5000000',
      },
      trade: {
        totalAmount: '10000000',
        supplierFirstTranche: '2000000',
        supplierSecondTranche: '3000000',
      },
      gateway: {
        refundEvents: [
          {
            eventType: 'reconciled',
            executionStatus: 'confirmed',
            reconciliationStatus: 'matched',
            txHash: '0xrefund',
          },
        ],
      },
      gatewayEvidence: {
        callbackDeliveries: [
          {
            eventType: 'reconciled',
            reconciliationStatus: 'matched',
            status: 'delivered',
            deliveredAt: '2026-05-30T00:00:00.000Z',
          },
        ],
      },
      backendEvidence: {
        accounting: [{ id: 1 }],
        refundEvents: [
          {
            eventType: 'execution_reconciled',
            sourceSystem: 'reconciler',
            externalTransactionHash: '0xrefund',
            observedBuyerRefundCents: '300',
          },
        ],
      },
    }),
  );

  withEnv(
    {
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'live', output: 'unused.json', evidenceFile },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'pass');
      assert.equal(report.evidence.type, 'live-base-sepolia-proof');
      assert.equal(report.evidence.transactionCount, 6);
      assert.equal(report.evidence.backendAccountingEntries, 1);
      assert.equal(report.evidence.backendRefundEvents, 1);
      assert.equal(report.evidence.gatewayRefundEvents, 1);
      assert.equal(report.evidence.gatewayCallbackDeliveries, 1);
      assert.deepEqual(report.evidence.failureModes, {
        expiredAuthorization: true,
        idempotentReplay: true,
        relayerOutageOrDisabled: true,
        fallbackUx: true,
        operatorFailureRehearsal: true,
      });
    },
  );
});

test('gasless relayer capacity live mode rejects proof without failure-mode evidence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasless-capacity-'));
  const evidenceFile = path.join(tmpDir, 'live-proof.json');
  fs.writeFileSync(
    evidenceFile,
    JSON.stringify({
      transactions: {
        createTradeGasless: '0xcreate',
        stage1Release: '0xstage1',
        confirmArrival: '0xarrival',
        openDisputeGasless: '0xdispute',
        proposeRefund: '0xproposal',
        approveRefund: '0xrefund',
      },
      currentRunEvidence: {
        balanceDeltas: {
          buyerUsdc: '-7000000',
          supplierUsdc: '2000000',
          serviceEthWei: '-1000000000000',
        },
        nonRefundableFeesAddedToTreasury: '5000000',
        expectedNonRefundableFees: '5000000',
      },
      trade: {
        totalAmount: '10000000',
        supplierFirstTranche: '2000000',
        supplierSecondTranche: '3000000',
      },
      gateway: {
        refundEvents: [
          {
            eventType: 'reconciled',
            executionStatus: 'confirmed',
            reconciliationStatus: 'matched',
            txHash: '0xrefund',
          },
        ],
      },
      gatewayEvidence: {
        callbackDeliveries: [
          {
            eventType: 'reconciled',
            reconciliationStatus: 'matched',
            status: 'delivered',
            deliveredAt: '2026-05-30T00:00:00.000Z',
          },
        ],
      },
      backendEvidence: {
        accounting: [{ id: 1 }],
        refundEvents: [
          {
            eventType: 'execution_reconciled',
            sourceSystem: 'reconciler',
            externalTransactionHash: '0xrefund',
            observedBuyerRefundCents: '300',
          },
        ],
      },
    }),
  );

  withEnv(
    {
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'live', output: 'unused.json', evidenceFile },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.match(report.blockers.join('\n'), /expired gasless authorization rejection/);
      assert.match(report.blockers.join('\n'), /idempotent replay/);
      assert.match(report.blockers.join('\n'), /disabled-relayer rehearsal/);
      assert.match(report.blockers.join('\n'), /fallback UX/);
      assert.match(report.blockers.join('\n'), /operator failure rehearsal/);
    },
  );
});

test('gasless relayer capacity live mode rejects weak failure evidence references', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasless-capacity-'));
  const evidenceFile = path.join(tmpDir, 'live-proof.json');
  fs.writeFileSync(
    evidenceFile,
    JSON.stringify({
      transactions: {
        createTradeGasless: '0xcreate',
        stage1Release: '0xstage1',
        confirmArrival: '0xarrival',
        openDisputeGasless: '0xdispute',
        proposeRefund: '0xproposal',
        approveRefund: '0xrefund',
      },
      failureModeEvidence: {
        expiredAuthorization: {
          passed: true,
          noTradeCreated: true,
        },
        idempotentReplay: {
          passed: true,
          noDuplicateTradeCreated: true,
        },
        relayerOutageOrDisabled: {
          status: 'provided',
          evidenceRef: 'ticket-only',
        },
        fallbackUx: {
          status: 'provided',
          evidenceRef: 'ticket-only',
        },
        operatorFailureRehearsal: {
          status: 'provided',
          evidenceRef: 'ticket-only',
        },
      },
      currentRunEvidence: {
        balanceDeltas: {
          buyerUsdc: '-7000000',
          supplierUsdc: '2000000',
          serviceEthWei: '-1000000000000',
        },
        nonRefundableFeesAddedToTreasury: '5000000',
        expectedNonRefundableFees: '5000000',
      },
      trade: {
        totalAmount: '10000000',
        supplierFirstTranche: '2000000',
        supplierSecondTranche: '3000000',
      },
      gateway: {
        refundEvents: [
          {
            eventType: 'reconciled',
            executionStatus: 'confirmed',
            reconciliationStatus: 'matched',
            txHash: '0xrefund',
          },
        ],
      },
      gatewayEvidence: {
        callbackDeliveries: [
          {
            eventType: 'reconciled',
            reconciliationStatus: 'matched',
            status: 'delivered',
            deliveredAt: '2026-05-30T00:00:00.000Z',
          },
        ],
      },
      backendEvidence: {
        accounting: [{ id: 1 }],
        refundEvents: [
          {
            eventType: 'execution_reconciled',
            sourceSystem: 'reconciler',
            externalTransactionHash: '0xrefund',
            observedBuyerRefundCents: '300',
          },
        ],
      },
    }),
  );

  withEnv(
    {
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
    },
    () => {
      const report = buildCapacityReport(
        { mode: 'live', output: 'unused.json', evidenceFile },
        new Date('2026-05-30T00:00:00.000Z'),
      );

      assert.equal(report.status, 'fail');
      assert.equal(report.evidence.failureModes.relayerOutageOrDisabled, false);
      assert.equal(report.evidence.failureModes.fallbackUx, false);
      assert.equal(report.evidence.failureModes.operatorFailureRehearsal, false);
    },
  );
});

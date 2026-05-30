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
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '100000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '50000000000000000',
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
      assert.equal(report.blockers.length, 0);
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
    },
  );
});

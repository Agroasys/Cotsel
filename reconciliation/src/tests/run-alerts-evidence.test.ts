import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationEvent } from '@agroasys/notifications';
import { serviceNotifications } from '../core/notifications';
import { RunAlerts } from '../core/runAlerts';
import type { TradeContainedAlertPayload } from '../types';

const BASE: TradeContainedAlertPayload = {
  runKey: 'daemon-1',
  tradeId: '7',
  incidentReference: 'RECON-20261123-ABCDEF01',
  state: 'CONTAINED',
  qualifyingCodes: ['AMOUNT_MISMATCH'],
  openedRunKey: 'daemon-1',
  openedAt: '2026-11-23T10:00:00.000Z',
  observationCount: 1,
};

async function raised(payload: TradeContainedAlertPayload): Promise<NotificationEvent> {
  const events: NotificationEvent[] = [];
  const notifier = serviceNotifications.notifier as unknown as {
    enqueue: (event: NotificationEvent) => Promise<unknown>;
  };
  const original = notifier.enqueue;
  notifier.enqueue = async (event) => {
    events.push(event);
    return 'queued';
  };
  try {
    await new RunAlerts().tradeContained(payload);
  } finally {
    notifier.enqueue = original;
  }
  assert.equal(events.length, 1);
  return events[0];
}

test('the freeze request names the signed findings and the rules that opened it (Cotsel#951)', async () => {
  const digests = ['a'.repeat(64), 'b'.repeat(64)];
  const event = await raised({
    ...BASE,
    findingDigests: digests,
    rulesVersion: 'cotsel.reconciliation-risk-rules.v1',
    rulesDigest: 'c'.repeat(64),
  });
  assert.equal(event.type, 'RECONCILIATION_TRADE_CONTAINED');
  // Scalar strings only: the frozen notification-event.v1 metadata schema.
  assert.equal(event.metadata?.findingDigests, digests.join(','));
  assert.equal(event.metadata?.rulesVersion, 'cotsel.reconciliation-risk-rules.v1');
  assert.equal(event.metadata?.rulesDigest, 'c'.repeat(64));
});

test('an alert queued before signing shipped still renders', async () => {
  const event = await raised(BASE);
  assert.equal(event.metadata?.findingDigests, null);
  assert.equal(event.metadata?.rulesVersion, null);
});

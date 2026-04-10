import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DASHBOARD_PARITY_TRADE_ID,
  LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY,
  LOCAL_DEV_INDEXER_FIXTURE_EMPTY,
  buildLocalDevIndexerResponse,
  loadLocalDevTradeFixtures,
  normalizeLocalDevIndexerFixtureMode,
} from '../lib/local-dev-indexer-fixture.mjs';

test('normalizeLocalDevIndexerFixtureMode defaults to empty and rejects unknown modes', () => {
  assert.equal(normalizeLocalDevIndexerFixtureMode(undefined), LOCAL_DEV_INDEXER_FIXTURE_EMPTY);
  assert.equal(
    normalizeLocalDevIndexerFixtureMode(LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY),
    LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY,
  );
  assert.throws(
    () => normalizeLocalDevIndexerFixtureMode('random'),
    /Unsupported LOCAL_DEV_INDEXER_FIXTURE_MODE/,
  );
});

test('loadLocalDevTradeFixtures returns the canonical parity trade only when parity mode is enabled', async () => {
  const emptyTrades = await loadLocalDevTradeFixtures({
    fixtureMode: LOCAL_DEV_INDEXER_FIXTURE_EMPTY,
  });
  assert.deepEqual(emptyTrades, []);

  const parityTrades = await loadLocalDevTradeFixtures({
    fixtureMode: LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY,
  });
  assert.equal(parityTrades.length, 1);
  assert.equal(parityTrades[0].tradeId, DASHBOARD_PARITY_TRADE_ID);
});

test('buildLocalDevIndexerResponse preserves list and detail semantics for the seeded trade', async () => {
  const trades = await loadLocalDevTradeFixtures({
    fixtureMode: LOCAL_DEV_INDEXER_FIXTURE_DASHBOARD_PARITY,
  });

  const listPayload = buildLocalDevIndexerResponse({
    operationName: 'DashboardTrades',
    variables: { limit: 1, offset: 0 },
    trades,
  });
  assert.equal(listPayload.data.trades[0].tradeId, DASHBOARD_PARITY_TRADE_ID);
  assert.equal(listPayload.data.trades.length, 1);

  const offsetPayload = buildLocalDevIndexerResponse({
    operationName: 'DashboardTrades',
    variables: { limit: 1, offset: 1 },
    trades,
  });
  assert.deepEqual(offsetPayload.data.trades, []);

  const detailPayload = buildLocalDevIndexerResponse({
    operationName: 'DashboardTradeDetail',
    variables: { tradeId: DASHBOARD_PARITY_TRADE_ID },
    trades,
  });
  assert.equal(detailPayload.data.trades[0].tradeId, DASHBOARD_PARITY_TRADE_ID);

  const missingDetailPayload = buildLocalDevIndexerResponse({
    operationName: 'DashboardTradeDetail',
    variables: { tradeId: 'TRD-missing' },
    trades,
  });
  assert.deepEqual(missingDetailPayload.data.trades, []);
});

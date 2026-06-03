import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('all indexed trade events persist EVM ordering fields', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const eventBlocks = [...source.matchAll(/new TradeEvent\(\{([\s\S]*?)\n\s*\}\)/g)].map(
    (match) => match[1],
  );

  assert.ok(eventBlocks.length > 0, 'expected indexed trade events in indexer/src/main.ts');

  for (const block of eventBlocks) {
    const eventName = block.match(/eventName:\s*'([^']+)'/)?.[1] ?? 'unknown';

    assert.match(block, /\blogIndex\b/, `${eventName} must persist logIndex`);
    assert.match(block, /\btransactionIndex\b/, `${eventName} must persist transactionIndex`);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('UnpauseApproved SystemEvent persists approvalCount and requiredApprovals', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  const systemEventBlocks = [...source.matchAll(/new SystemEvent\(\{([\s\S]*?)\n\s*\}\)/g)].map(
    (match) => match[1],
  );

  assert.ok(systemEventBlocks.length > 0, 'expected SystemEvent blocks in indexer/src/main.ts');

  const unpauseApprovedBlock = systemEventBlocks.find((block) =>
    block.includes("eventName: 'UnpauseApproved'"),
  );

  assert.ok(
    unpauseApprovedBlock,
    'expected a SystemEvent block with eventName UnpauseApproved in indexer/src/main.ts',
  );
  assert.match(
    unpauseApprovedBlock,
    /\bapprovalCount\b/,
    'UnpauseApproved SystemEvent must persist approvalCount',
  );
  assert.match(
    unpauseApprovedBlock,
    /\brequiredApprovals\b/,
    'UnpauseApproved SystemEvent must persist requiredApprovals',
  );
});

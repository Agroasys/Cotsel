/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateTradeParameters } from '../src/utils/validation';
import type { BuyerLockPayload } from '../src/types/trade';

const REPO_ROOT = path.resolve(__dirname, '..');
const TYPE_FILE = path.join(REPO_ROOT, 'src/types/trade.ts');
const RUNBOOK_FILE = path.resolve(REPO_ROOT, '..', 'docs/runbooks/buyer-lock-payload.md');

function extractBuyerLockPayloadFields(source: string): string[] {
  const interfaceMatch = source.match(/export interface BuyerLockPayload \{([\s\S]*?)\n\}/);
  if (!interfaceMatch) {
    throw new Error('BuyerLockPayload interface not found in sdk/src/types/trade.ts');
  }

  return interfaceMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('/**'))
    .map((line) => line.match(/^([a-zA-Z][a-zA-Z0-9_]*)\??:/)?.[1] ?? null)
    .filter((field): field is string => field !== null);
}

function extractRunbookFields(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.match(/^\| `([^`]+)` \|/)?.[1] ?? null)
    .filter((field): field is string => field !== null);
}

describe('BuyerLockPayload contract', () => {
  test('runbook field table matches the canonical BuyerLockPayload type', () => {
    const typeSource = fs.readFileSync(TYPE_FILE, 'utf8');
    const runbookSource = fs.readFileSync(RUNBOOK_FILE, 'utf8');

    const typeFields = extractBuyerLockPayloadFields(typeSource);
    const runbookFields = extractRunbookFields(runbookSource);

    expect(runbookFields).toEqual(typeFields);
    expect(runbookSource).toMatch(/\*\*Backward-compatible alias:\*\* `TradeParameters`/);
  });

  test('canonical payload example remains valid against runtime validation', () => {
    const payload: BuyerLockPayload = {
      supplier: '0x1111111111111111111111111111111111111111',
      totalAmount: 141_500_000n,
      logisticsAmount: 10_000_000n,
      platformFeesAmount: 1_500_000n,
      supplierFirstTranche: 52_000_000n,
      supplierSecondTranche: 78_000_000n,
      ricardianHash: `0x${'a'.repeat(64)}`,
    };

    expect(() => validateTradeParameters(payload)).not.toThrow();
  });
});

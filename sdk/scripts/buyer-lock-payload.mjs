/** SPDX-License-Identifier: Apache-2.0 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateTradeParameters } = require('../dist/index.js');

// JSON base-unit amounts must be decimal strings so parsing never loses precision.
export function parseBuyerLockPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected a backend BuyerLockPayload object');
  const payload = { supplier: input.supplier, ricardianHash: input.ricardianHash };
  for (const name of [
    'totalAmount',
    'logisticsAmount',
    'platformFeesAmount',
    'supplierFirstTranche',
    'supplierSecondTranche',
  ]) {
    if (typeof input[name] !== 'string' || !/^\d+$/.test(input[name]))
      throw new Error(`${name} must be an unsigned base-unit decimal string`);
    const amount = BigInt(input[name]);
    if (amount % 10_000n !== 0n) throw new Error(`${name} must be a whole USD cent`);
    payload[name] = amount;
  }
  if (input.deadline !== null && input.deadline !== undefined) {
    if (!Number.isSafeInteger(input.deadline) || input.deadline <= 0)
      throw new Error('deadline must be a positive integer timestamp');
    payload.deadline = input.deadline;
  }
  validateTradeParameters(payload);
  return payload;
}

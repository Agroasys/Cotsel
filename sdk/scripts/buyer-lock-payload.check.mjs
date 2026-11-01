/** SPDX-License-Identifier: Apache-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBuyerLockPayload } from './buyer-lock-payload.mjs';
const example = {
  supplier: '0x1111111111111111111111111111111111111111',
  totalAmount: '1059000000',
  logisticsAmount: '50000000',
  platformFeesAmount: '14000000',
  supplierFirstTranche: '595000000',
  supplierSecondTranche: '400000000',
  ricardianHash: '0x' + 'ab'.repeat(32),
};
test('preserves backend amounts and legal hash exactly', () => {
  const payload = parseBuyerLockPayload(example);
  assert.equal(payload.totalAmount, 1059000000n);
  assert.equal(payload.platformFeesAmount, 14000000n);
  assert.equal(payload.ricardianHash, example.ricardianHash);
});
test('rejects lossy JSON numbers, sub-cent amounts, bad sums, missing components and missing legal hash', () => {
  for (const patch of [
    { totalAmount: 1059000000 },
    { logisticsAmount: '50000001' },
    { totalAmount: '1059000001' },
    { totalAmount: '10590000000' },
    { supplierFirstTranche: undefined },
    { ricardianHash: undefined },
  ]) {
    assert.throws(() => parseBuyerLockPayload({ ...example, ...patch }));
  }
});

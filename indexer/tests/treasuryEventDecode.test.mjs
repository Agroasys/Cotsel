import assert from 'node:assert/strict';
import test from 'node:test';

import { contractInterface } from '../lib/abi.js';

const treasuryIdentity = '0x1111111111111111111111111111111111111111';
const payoutReceiver = '0x2222222222222222222222222222222222222222';
const triggeredBy = '0x3333333333333333333333333333333333333333';

test('ABI can decode TreasuryClaimed deterministically', () => {
  const fragment = contractInterface.getEvent('TreasuryClaimed');
  const encoded = contractInterface.encodeEventLog(fragment, [
    treasuryIdentity,
    payoutReceiver,
    123n,
    triggeredBy,
  ]);

  const decoded = contractInterface.parseLog({
    topics: encoded.topics,
    data: encoded.data,
  });

  assert.equal(decoded?.name, 'TreasuryClaimed');
  assert.equal(decoded?.args?.treasuryIdentity?.toLowerCase(), treasuryIdentity);
  assert.equal(decoded?.args?.payoutReceiver?.toLowerCase(), payoutReceiver);
  assert.equal(decoded?.args?.triggeredBy?.toLowerCase(), triggeredBy);
  assert.equal(decoded?.args?.amount, 123n);
});

test('ABI can decode TreasuryPayoutAddressUpdateProposed deterministically', () => {
  const fragment = contractInterface.getEvent('TreasuryPayoutAddressUpdateProposed');
  const encoded = contractInterface.encodeEventLog(fragment, [
    9n,
    triggeredBy,
    payoutReceiver,
    1000n,
  ]);

  const decoded = contractInterface.parseLog({
    topics: encoded.topics,
    data: encoded.data,
  });

  assert.equal(decoded?.name, 'TreasuryPayoutAddressUpdateProposed');
  assert.equal(decoded?.args?.proposalId, 9n);
  assert.equal(decoded?.args?.proposer?.toLowerCase(), triggeredBy);
  assert.equal(decoded?.args?.newPayoutReceiver?.toLowerCase(), payoutReceiver);
  assert.equal(decoded?.args?.eta, 1000n);
});

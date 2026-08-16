import assert from 'node:assert/strict';
import test from 'node:test';

import { markGovernanceProposalExecuted } from '../lib/governanceProjection.js';

test('governance execution marks and retains the proposal as executed', () => {
  const proposals = new Map();
  const proposal = { executed: false, approvalCount: 2 };

  const result = markGovernanceProposalExecuted(proposals, '7', proposal);

  assert.equal(result.executed, true);
  assert.equal(proposals.get('7'), proposal);
  assert.equal(proposals.get('7').executed, true);
});

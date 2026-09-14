import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import {
  GovernedApprovalError,
  PAUSE_SCOPE_TRADE,
  evaluateGovernedUnpause,
  incidentRefCandidates,
  matchesIncidentReference,
  normalizeTxHash,
} from '../core/governedApproval';
import type { ContainmentUnderRelease, GovernedUnpauseFacts } from '../core/governedApproval';

const ESCROW = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER_CONTRACT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const APPROVER_A = '0x1111111111111111111111111111111111111111';
const APPROVER_B = '0x2222222222222222222222222222222222222222';
const INCIDENT = 'RECON-20260912-AB12CD34';
const TX = '0x' + 'ab'.repeat(32);

const CONTAINMENT: ContainmentUnderRelease = {
  tradeId: '7',
  incidentReference: INCIDENT,
  openedAt: new Date('2026-09-12T00:00:00Z'),
};

function facts(overrides: Partial<GovernedUnpauseFacts> = {}): GovernedUnpauseFacts {
  return {
    txHash: TX,
    chainId: 84532,
    escrowAddress: ESCROW,
    receiptStatus: 1,
    blockNumber: 4200,
    blockHash: '0x' + 'cd'.repeat(32),
    // A day after the incident was opened.
    blockTimestamp: Math.floor(new Date('2026-09-13T00:00:00Z').getTime() / 1000),
    finalityBlockNumber: 4300,
    unpausedLogs: [{ address: ESCROW, tradeId: '7', logIndex: 5 }],
    approvalLogs: [
      {
        address: ESCROW,
        approver: APPROVER_A,
        approvalCount: 1,
        requiredApprovals: 2,
        logIndex: 3,
      },
      {
        address: ESCROW,
        approver: APPROVER_B,
        approvalCount: 2,
        requiredApprovals: 2,
        logIndex: 4,
      },
    ],
    proposal: {
      scope: PAUSE_SCOPE_TRADE,
      tradeId: '7',
      incidentRef: ethers.encodeBytes32String(INCIDENT),
      approvalCount: 2,
      executed: true,
    },
    ...overrides,
  };
}

function refuses(overrides: Partial<GovernedUnpauseFacts>, pattern: RegExp): void {
  assert.throws(
    () => evaluateGovernedUnpause(facts(overrides), CONTAINMENT),
    (error: unknown) => {
      assert.ok(error instanceof GovernedApprovalError, `expected a refusal, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test('a transaction hash must be a 32-byte hash', () => {
  assert.equal(normalizeTxHash(` ${TX.toUpperCase()} `), TX);
  assert.throws(() => normalizeTxHash('GOV-1'), GovernedApprovalError);
  assert.throws(() => normalizeTxHash('0xdeadbeef'), GovernedApprovalError);
});

test('an incident reference binds either as text or as its hash', () => {
  const [asText, asHash] = incidentRefCandidates(INCIDENT);

  assert.equal(asText, ethers.encodeBytes32String(INCIDENT).toLowerCase());
  assert.equal(asHash, ethers.keccak256(ethers.toUtf8Bytes(INCIDENT)).toLowerCase());
  assert.equal(matchesIncidentReference(asText, INCIDENT), true);
  assert.equal(matchesIncidentReference(asHash, INCIDENT), true);
  assert.equal(
    matchesIncidentReference(ethers.encodeBytes32String('RECON-OTHER'), INCIDENT),
    false,
  );
});

test('a quorum-executed per-trade unpause releases the containment', () => {
  const evidence = evaluateGovernedUnpause(facts(), CONTAINMENT);

  assert.equal(evidence.txHash, TX);
  assert.equal(evidence.chainId, 84532);
  assert.equal(evidence.contractAddress, ESCROW);
  assert.equal(evidence.tradeId, '7');
  assert.equal(evidence.blockNumber, 4200);
  assert.equal(evidence.logIndex, 5);
  assert.equal(evidence.approvalCount, 2);
  assert.equal(evidence.requiredApprovals, 2);
  assert.deepEqual(evidence.approvers, [APPROVER_A, APPROVER_B]);
  assert.equal(evidence.executedAt.toISOString(), '2026-09-13T00:00:00.000Z');
});

test('the incident reference may be carried on chain as a hash', () => {
  const evidence = evaluateGovernedUnpause(
    facts({
      proposal: {
        scope: PAUSE_SCOPE_TRADE,
        tradeId: '7',
        incidentRef: ethers.keccak256(ethers.toUtf8Bytes(INCIDENT)),
        approvalCount: 2,
        executed: true,
      },
    }),
    CONTAINMENT,
  );

  assert.equal(evidence.incidentRef, ethers.keccak256(ethers.toUtf8Bytes(INCIDENT)));
});

test('an unmined or reverted transaction approves nothing', () => {
  refuses({ receiptStatus: null }, /No transaction receipt/u);
  refuses({ receiptStatus: 0 }, /reverted/u);
});

test('an unfinalized approval cannot lift a pause', () => {
  // Releasing on a re-orgable block could clear a containment whose unpause
  // later never happened.
  refuses({ blockNumber: 4301, finalityBlockNumber: 4300 }, /past the finality boundary/u);
});

test('an unpause for another trade does not release this one', () => {
  refuses(
    { unpausedLogs: [{ address: ESCROW, tradeId: '8', logIndex: 5 }] },
    /emits no TradeUnpaused for trade 7/u,
  );
});

test('a TradeUnpaused from another contract is ignored', () => {
  // Anyone can deploy a contract that emits this event shape.
  refuses(
    { unpausedLogs: [{ address: OTHER_CONTRACT, tradeId: '7', logIndex: 5 }] },
    /emits no TradeUnpaused for trade 7/u,
  );
});

test('a global or claims recovery does not release a contained trade', () => {
  refuses(
    {
      proposal: {
        scope: 0,
        tradeId: '7',
        incidentRef: ethers.encodeBytes32String(INCIDENT),
        approvalCount: 2,
        executed: true,
      },
    },
    /not a per-trade unpause/u,
  );
});

test('an approval for a different incident is not transferable', () => {
  refuses(
    {
      proposal: {
        scope: PAUSE_SCOPE_TRADE,
        tradeId: '7',
        incidentRef: ethers.encodeBytes32String('RECON-20260101-DEADBEEF'),
        approvalCount: 2,
        executed: true,
      },
    },
    /not transferable between incidents/u,
  );
});

test('a proposal that never executed is not an approval', () => {
  refuses(
    {
      proposal: {
        scope: PAUSE_SCOPE_TRADE,
        tradeId: '7',
        incidentRef: ethers.encodeBytes32String(INCIDENT),
        approvalCount: 1,
        executed: false,
      },
    },
    /not marked executed/u,
  );
});

test('a short quorum is refused', () => {
  refuses(
    {
      approvalLogs: [
        {
          address: ESCROW,
          approver: APPROVER_A,
          approvalCount: 1,
          requiredApprovals: 2,
          logIndex: 3,
        },
      ],
    },
    /reached 1 of 2 required approvals/u,
  );
});

test('a transaction with no approval record establishes no quorum', () => {
  refuses({ approvalLogs: [] }, /records no UnpauseApproved/u);
});

test('an approval that predates the incident cannot release it', () => {
  // The replay this blocks: a real, past governance receipt presented against a
  // containment opened afterwards.
  refuses(
    { blockTimestamp: Math.floor(new Date('2026-09-11T00:00:00Z').getTime() / 1000) },
    /an earlier approval cannot release a later containment/u,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCursorHold,
  evaluateIndexerAnchor,
  evaluateIndexerSnapshot,
  isCoverageComplete,
} from '../core/coverage';

/**
 * Second-round review findings on WP-3 chain coverage.
 *
 * 1. Reading the indexer's processed block once does not snapshot its GraphQL
 *    data. The projection can advance while the batches, the id enumeration and
 *    the count run, so a run must confirm the height held still before it
 *    publishes drift or advances the cursor.
 * 2. A truncated id enumeration left the run free to report a complete sweep
 *    even though ids beyond the bound were never checked.
 * 3. The last null-anchor path: an unavailable initial checkpoint was replaced
 *    with the chain finality block before the boundary was resolved, so the
 *    end-of-run snapshot check saw two equal numbers and accepted the run.
 */

// ---------------------------------------------------------------------------
// Issue 1: the indexer must hold one height for the whole run.
// ---------------------------------------------------------------------------

test('a run whose indexer height never moved is a usable snapshot', () => {
  const verdict = evaluateIndexerSnapshot({ anchorBlock: 4242, endBlock: 4242 });

  assert.equal(verdict.stable, true);
  assert.equal(verdict.reason, null);
});

test('an indexer that advanced mid-run yields an unusable snapshot', () => {
  // The chain reads were anchored at 4242 while the last GraphQL answers came
  // from 4250, so any difference between them is a height artefact.
  const verdict = evaluateIndexerSnapshot({ anchorBlock: 4242, endBlock: 4250 });

  assert.equal(verdict.stable, false);
  assert.match(verdict.reason ?? '', /advanced from block 4242 to 4250/);
});

test('an indexer that went backwards is also unusable', () => {
  const verdict = evaluateIndexerSnapshot({ anchorBlock: 4250, endBlock: 4242 });

  assert.equal(verdict.stable, false);
  assert.match(verdict.reason ?? '', /advanced from block 4250 to 4242/);
});

test('an unknown height is never silently treated as a valid anchor', () => {
  // The old null fallback compared live indexer state against a finalized chain
  // block. Without a height there is nothing to anchor the chain reads to.
  for (const bounds of [
    { anchorBlock: null, endBlock: 4242 },
    { anchorBlock: 4242, endBlock: null },
    { anchorBlock: null, endBlock: null },
  ]) {
    const verdict = evaluateIndexerSnapshot(bounds);
    assert.equal(verdict.stable, false, JSON.stringify(bounds));
    assert.match(verdict.reason ?? '', /processed block unavailable/);
  }
});

// ---------------------------------------------------------------------------
// Issue 2: a truncated enumeration is an incomplete coverage result.
// ---------------------------------------------------------------------------

test('a swept window with an exhausted enumeration is complete coverage', () => {
  assert.equal(isCoverageComplete({ windowComplete: true, enumerationTruncated: false }), true);
});

test('a truncated enumeration is not complete coverage even when the window finished', () => {
  // Ids beyond the enumeration bound were never checked, so the indexer-only
  // direction is unproven over the rest of the range.
  assert.equal(isCoverageComplete({ windowComplete: true, enumerationTruncated: true }), false);
});

test('an unfinished window is incomplete regardless of the enumeration', () => {
  assert.equal(isCoverageComplete({ windowComplete: false, enumerationTruncated: false }), false);
  assert.equal(isCoverageComplete({ windowComplete: false, enumerationTruncated: true }), false);
});

test('a truncated enumeration alone holds the cursor', () => {
  // Without this the run advanced past ids it never enumerated and the next
  // run resumed beyond them, retiring them permanently.
  const verdict = evaluateCursorHold({ holdingFindingCount: 0, enumerationTruncated: true });

  assert.equal(verdict.held, true);
  assert.deepEqual(verdict.reasons, ['indexer id enumeration truncated before completing']);
});

test('an unreconciled finding alone holds the cursor', () => {
  const verdict = evaluateCursorHold({ holdingFindingCount: 3, enumerationTruncated: false });

  assert.equal(verdict.held, true);
  assert.deepEqual(verdict.reasons, ['3 unreconciled finding(s)']);
});

test('both causes are reported together so the operator sees the whole hold', () => {
  const verdict = evaluateCursorHold({ holdingFindingCount: 2, enumerationTruncated: true });

  assert.equal(verdict.held, true);
  assert.deepEqual(verdict.reasons, [
    '2 unreconciled finding(s)',
    'indexer id enumeration truncated before completing',
  ]);
});

test('a clean, fully enumerated run releases the cursor', () => {
  const verdict = evaluateCursorHold({ holdingFindingCount: 0, enumerationTruncated: false });

  assert.equal(verdict.held, false);
  assert.deepEqual(verdict.reasons, []);
});

// ---------------------------------------------------------------------------
// Issue 3: a missing initial checkpoint is never substituted.
// ---------------------------------------------------------------------------

const FINALITY_BLOCK = 4242;

/**
 * The run's anchoring gate, in the order `reconcileOnce` applies it: the
 * checkpoint decides whether a chain boundary is resolved at all, and only an
 * anchored run reaches the end-of-run snapshot check. `boundariesResolved`
 * stands in for `OnchainClient.resolveBoundary`, which the gate must keep the
 * run away from when there is no checkpoint to pin it to.
 */
function gateRun(input: { checkpoint: number | null; endBlock: number | null }): {
  published: boolean;
  reason: string | null;
  boundariesResolved: number;
} {
  let boundariesResolved = 0;

  const anchor = evaluateIndexerAnchor(input.checkpoint);
  if (!anchor.usable) {
    return { published: false, reason: anchor.reason, boundariesResolved };
  }

  boundariesResolved += 1;
  const snapshot = evaluateIndexerSnapshot({
    anchorBlock: anchor.anchorBlock,
    endBlock: input.endBlock,
  });

  return { published: snapshot.stable, reason: snapshot.reason, boundariesResolved };
}

test('a null checkpoint is rejected even when the final read matches the finality height', () => {
  // The regression: `resolveBoundary(null)` substituted the finality block and
  // stored it as the anchor, so a final height read landing on that same block
  // compared equal and the run published drift decided against a projection it
  // never had a checkpoint for.
  const verdict = gateRun({ checkpoint: null, endBlock: FINALITY_BLOCK });

  assert.equal(verdict.published, false);
  assert.match(verdict.reason ?? '', /processed block unavailable/);
  assert.equal(
    verdict.boundariesResolved,
    0,
    'the chain boundary must not be resolved without an indexer checkpoint',
  );
});

test('a null checkpoint is rejected whatever the final read returns', () => {
  for (const endBlock of [null, FINALITY_BLOCK - 1, FINALITY_BLOCK, FINALITY_BLOCK + 1]) {
    const verdict = gateRun({ checkpoint: null, endBlock });

    assert.equal(verdict.published, false, `endBlock=${endBlock}`);
    assert.equal(verdict.boundariesResolved, 0, `endBlock=${endBlock}`);
  }
});

test('a real checkpoint that held still anchors the run and publishes', () => {
  // The control: the gate only rejects a missing checkpoint, not a trailing one
  // that happens to sit below the chain finality block.
  const verdict = gateRun({ checkpoint: FINALITY_BLOCK - 300, endBlock: FINALITY_BLOCK - 300 });

  assert.equal(verdict.published, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.boundariesResolved, 1);
});

test('a read checkpoint is carried through as the anchor, never defaulted', () => {
  const anchor = evaluateIndexerAnchor(940);

  assert.equal(anchor.usable, true);
  assert.equal(anchor.anchorBlock, 940);
  assert.equal(anchor.reason, null);
});

test('an unavailable checkpoint yields no anchor block at all', () => {
  const anchor = evaluateIndexerAnchor(null);

  assert.equal(anchor.usable, false);
  assert.equal(anchor.anchorBlock, null);
  assert.match(anchor.reason ?? '', /processed block unavailable/);
});

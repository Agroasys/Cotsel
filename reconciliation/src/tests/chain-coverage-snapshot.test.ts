import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCursorHold, evaluateIndexerSnapshot, isCoverageComplete } from '../core/coverage';

/**
 * Second-round review findings on WP-3 chain coverage.
 *
 * 1. Reading the indexer's processed block once does not snapshot its GraphQL
 *    data. The projection can advance while the batches, the id enumeration and
 *    the count run, so a run must confirm the height held still before it
 *    publishes drift or advances the cursor.
 * 2. A truncated id enumeration left the run free to report a complete sweep
 *    even though ids beyond the bound were never checked.
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

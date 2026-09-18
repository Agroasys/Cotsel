/**
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maker-checker transitions are read-then-write: a handler reads the current
 * financial state, decides the transition is legal, and writes the next state.
 * Two callers racing on the same row can both read the same "before" state and
 * both write, which silently overwrites the actor chain and lets one approval
 * stand in for two. Every such write therefore takes the row lock first and
 * carries an expected-state predicate, so exactly one of a racing pair commits
 * and the loser is rejected instead of overwriting.
 */

const UNIQUE_VIOLATION = '23505';

export class TreasuryConcurrentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreasuryConcurrentTransitionError';
  }
}

/**
 * A losing racer can surface either as an expected-state predicate that matched
 * no row or as a unique-constraint violation, depending on which guard the
 * database reached first. Both mean the same thing to the caller.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export function assertTransitionApplied(rowCount: number | null, message: string): void {
  if (!rowCount) {
    throw new TreasuryConcurrentTransitionError(message);
  }
}

export async function rejectConcurrentWrite<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TreasuryConcurrentTransitionError(message);
    }
    throw error;
  }
}

/**
 * The idempotent upserts decide "already recorded?" by reading before they
 * write, so two identical callbacks arriving together can both reach the
 * insert. Retrying the whole operation once lets the loser take the same
 * already-recorded path it would have taken had it arrived a moment later:
 * an identical payload is an idempotent replay, a differing one is a conflict.
 */
export async function retryOnceOnUniqueViolation<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    return rejectConcurrentWrite(operation, message);
  }
}

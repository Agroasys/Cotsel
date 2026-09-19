/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-11: the one place that decides what a provider state means.
 *
 * Treasury carried two provider vocabularies that had drifted apart --
 * `TreasuryPartnerHandoffStatus` at the ledger entry, `PartnerHandoffStatus` at
 * the sweep batch -- and neither of them said anything about *authority*. Code
 * asked "what did the provider last say" and then acted as though the answer
 * were "has value moved". Those are different questions, and the gap between
 * them is the finding: a batch was marked HANDED_OFF on the strength of a
 * `CREATED` or `FAILED` provider status, because the transition looked only at
 * the batch's own state and never at what the provider had actually reported.
 *
 * Two rules, stated once:
 *
 *   1. Authority. `CREATED` is an intent, not a movement, and `FAILED` and
 *      `RETURNED` are the absence of one. Only `COMPLETED` carries completion,
 *      and only with authoritative provider or bank evidence attached.
 *   2. Monotonicity. Provider evidence is append-only. A later callback may
 *      advance the authoritative state or repeat it; a stale or reordered one
 *      is recorded without regressing it; and two different terminal claims
 *      about the same handoff are a contradiction that freezes rather than
 *      overwrites.
 */

/**
 * The union of both legacy vocabularies. A provider state Cotsel cannot name is
 * not mapped to a default -- `resolveProviderHandoffAuthority` refuses it --
 * because the safe-looking default is the one that reads as progress.
 */
export type ProviderHandoffStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETURNED';

export const PROVIDER_HANDOFF_STATUSES: readonly ProviderHandoffStatus[] = [
  'CREATED',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETURNED',
];

/**
 * What a provider state entitles treasury to do, as distinct from what the
 * provider called it.
 *
 * - `NOT_HANDED_OFF` -- nothing has left. The batch stays where it is.
 * - `IN_FLIGHT`      -- the provider has the instruction. Handed off, not complete.
 * - `COMPLETE`       -- value movement is asserted, and still needs evidence.
 * - `TERMINAL_FAILED`-- the instruction ended without movement.
 */
export type ProviderHandoffAuthority =
  | 'NOT_HANDED_OFF'
  | 'IN_FLIGHT'
  | 'COMPLETE'
  | 'TERMINAL_FAILED';

const AUTHORITY: Readonly<Record<ProviderHandoffStatus, ProviderHandoffAuthority>> = {
  CREATED: 'NOT_HANDED_OFF',
  SUBMITTED: 'IN_FLIGHT',
  ACKNOWLEDGED: 'IN_FLIGHT',
  PROCESSING: 'IN_FLIGHT',
  COMPLETED: 'COMPLETE',
  FAILED: 'TERMINAL_FAILED',
  RETURNED: 'TERMINAL_FAILED',
};

/**
 * Ranks order progress within one instruction. `ACKNOWLEDGED` and `PROCESSING`
 * share a rank deliberately: providers emit one, the other, or both, and
 * treating either as "further along" would make the order of arrival decide the
 * authoritative state.
 */
const RANK: Readonly<Record<ProviderHandoffStatus, number>> = {
  CREATED: 0,
  SUBMITTED: 1,
  ACKNOWLEDGED: 2,
  PROCESSING: 2,
  COMPLETED: 3,
  FAILED: 3,
  RETURNED: 3,
};

const TERMINAL: ReadonlySet<ProviderHandoffStatus> = new Set(['COMPLETED', 'FAILED', 'RETURNED']);

export class ProviderHandoffAuthorityError extends Error {
  readonly code = 'PROVIDER_HANDOFF_STATE_UNKNOWN';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderHandoffAuthorityError';
  }
}

export function isProviderHandoffStatus(value: unknown): value is ProviderHandoffStatus {
  return (
    typeof value === 'string' && PROVIDER_HANDOFF_STATUSES.includes(value as ProviderHandoffStatus)
  );
}

export function resolveProviderHandoffAuthority(
  status: ProviderHandoffStatus,
): ProviderHandoffAuthority {
  const authority = AUTHORITY[status];
  if (!authority) {
    throw new ProviderHandoffAuthorityError(
      `Provider handoff status "${status}" has no authoritative mapping and cannot advance a handoff`,
    );
  }

  return authority;
}

/** True only for the one state that asserts value movement. */
export function isHandoffComplete(status: ProviderHandoffStatus): boolean {
  return resolveProviderHandoffAuthority(status) === 'COMPLETE';
}

/**
 * True once the instruction is with the provider. `CREATED` is excluded on
 * purpose: this is the predicate a sweep batch consults before it may move to
 * HANDED_OFF, and a created-but-unsubmitted instruction has moved nothing.
 */
export function isHandedOff(status: ProviderHandoffStatus): boolean {
  const authority = resolveProviderHandoffAuthority(status);
  return authority === 'IN_FLIGHT' || authority === 'COMPLETE';
}

export function isTerminalProviderStatus(status: ProviderHandoffStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * - `ADVANCE`       -- apply it; this is the new authoritative state.
 * - `REPLAY`        -- the same state again; idempotent, nothing to apply.
 * - `STALE`         -- an older or reordered state; record it, keep the current one.
 * - `CONTRADICTION` -- a second, different terminal claim. Freeze; do not apply.
 */
export type ProviderHandoffTransition = 'ADVANCE' | 'REPLAY' | 'STALE' | 'CONTRADICTION';

export function classifyProviderHandoffTransition(
  from: ProviderHandoffStatus | null,
  to: ProviderHandoffStatus,
): ProviderHandoffTransition {
  resolveProviderHandoffAuthority(to);

  if (from === null) {
    return 'ADVANCE';
  }

  resolveProviderHandoffAuthority(from);

  if (from === to) {
    return 'REPLAY';
  }

  // Two different terminal claims about one instruction cannot both be true.
  // This is the case that must never resolve itself by last-write-wins: either
  // the provider contradicted itself or the evidence has been mixed up, and
  // both need a human before anything else advances.
  if (TERMINAL.has(from) && TERMINAL.has(to)) {
    return 'CONTRADICTION';
  }

  // A non-terminal update after a terminal one is a delayed or reordered
  // delivery, not a contradiction. It is recorded and ignored, so the single
  // authoritative outcome survives out-of-order callbacks.
  if (TERMINAL.has(from)) {
    return 'STALE';
  }

  return RANK[to] < RANK[from] ? 'STALE' : 'ADVANCE';
}

/**
 * Completion is the only transition that asserts value left Cotsel's control,
 * so it is the only one that must be corroborated by something the provider or
 * the bank produced. A `COMPLETED` status with nothing attached is a claim, and
 * this control exists because claims were being recorded as completions.
 */
export function assertCompletionEvidence(
  status: ProviderHandoffStatus,
  evidence: { evidenceReference?: string | null; bankReference?: string | null },
): void {
  if (!isHandoffComplete(status)) {
    return;
  }

  const hasEvidence = Boolean(evidence.evidenceReference?.trim() || evidence.bankReference?.trim());

  if (!hasEvidence) {
    throw new ProviderHandoffAuthorityError(
      'Completed external handoff requires an authoritative provider or bank evidence reference',
    );
  }
}

/**
 * The accounting projection lives in `@agroasys/sdk`, which is a published
 * package with its own narrower copy of this vocabulary (no `PROCESSING`, no
 * `RETURNED`). Widening it is an SDK release and a dashboard-visible contract
 * change, so treasury narrows at the boundary instead.
 *
 * The narrowing is lossless for the projection's purposes because the
 * projection reads authority, not the provider's exact word: `PROCESSING` is
 * in flight like `ACKNOWLEDGED`, and `RETURNED` ended without movement like
 * `FAILED`. The full-fidelity status stays on the row and in the evidence log.
 */
export type SdkPartnerHandoffStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'COMPLETED'
  | 'FAILED';

export function toSdkPartnerHandoffStatus(status: ProviderHandoffStatus): SdkPartnerHandoffStatus {
  if (status === 'PROCESSING') {
    return 'ACKNOWLEDGED';
  }

  if (status === 'RETURNED') {
    return 'FAILED';
  }

  return status;
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ACTIVE_PROPOSAL_STATUSES,
  decodeGovernanceActionCursor,
  GOVERNANCE_OPEN_INTENT_STATUSES,
  type GovernanceActionRecord,
  type GovernanceActionStore,
  nextGovernanceActionCursor,
} from './governanceStore';

export function createInMemoryGovernanceActionStore(
  initial: GovernanceActionRecord[] = [],
): GovernanceActionStore {
  const items = new Map<string, GovernanceActionRecord>(
    initial.map((action) => [action.actionId, action]),
  );

  function sorted(): GovernanceActionRecord[] {
    return [...items.values()].sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        return right.actionId.localeCompare(left.actionId);
      }

      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  return {
    async save(action) {
      items.set(action.actionId, {
        ...action,
        audit: {
          ...action.audit,
          evidenceLinks: [...action.audit.evidenceLinks],
          ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}),
        },
      });
      return (await this.get(action.actionId))!;
    },

    async get(actionId) {
      const action = items.get(actionId);
      return action
        ? {
            ...action,
            audit: {
              ...action.audit,
              evidenceLinks: [...action.audit.evidenceLinks],
              ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}),
            },
          }
        : null;
    },

    async findOpenByIntentKey(intentKey, now) {
      const action = sorted().find(
        (candidate) =>
          candidate.intentKey === intentKey &&
          GOVERNANCE_OPEN_INTENT_STATUSES.includes(candidate.status) &&
          !(
            candidate.status === 'prepared' &&
            candidate.expiresAt !== null &&
            candidate.expiresAt <= now
          ),
      );

      return action
        ? {
            ...action,
            audit: {
              ...action.audit,
              evidenceLinks: [...action.audit.evidenceLinks],
              ...(action.audit.approvedBy ? { approvedBy: [...action.audit.approvedBy] } : {}),
            },
          }
        : null;
    },

    async list(input) {
      let candidates = sorted();

      if (input.category) {
        candidates = candidates.filter((action) => action.category === input.category);
      }

      if (input.categories && input.categories.length > 0) {
        candidates = candidates.filter((action) => input.categories?.includes(action.category));
      }

      if (input.status) {
        candidates = candidates.filter((action) => action.status === input.status);
      }

      if (input.tradeId) {
        candidates = candidates.filter((action) => action.tradeId === input.tradeId);
      }

      if (input.cursor) {
        const cursor = decodeGovernanceActionCursor(input.cursor);
        candidates = candidates.filter(
          (action) =>
            action.createdAt < cursor.createdAt ||
            (action.createdAt === cursor.createdAt && action.actionId < cursor.actionId),
        );
      }

      const page = candidates.slice(0, input.limit + 1);
      return {
        items: page.slice(0, input.limit),
        nextCursor: nextGovernanceActionCursor(page, input.limit),
      };
    },

    async listActiveProposalIds(category) {
      const seen = new Set<number>();
      for (const action of sorted()) {
        if (
          action.category !== category ||
          action.proposalId === null ||
          !ACTIVE_PROPOSAL_STATUSES.includes(action.status)
        ) {
          continue;
        }
        seen.add(action.proposalId);
      }

      return [...seen].sort((left, right) => left - right);
    },
  };
}

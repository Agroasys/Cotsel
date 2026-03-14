/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  decodeGovernanceActionCursor,
  encodeGovernanceActionCursor,
  GovernanceActionCategory,
  GovernanceActionRecord,
  GovernanceActionStatus,
  GovernanceActionStore,
} from './governanceStore';
import {
  GovernanceMutationPreflightReader,
  GovernanceProposalState,
  GovernanceStatusSnapshot,
} from './governanceStatusService';
import { isoTimestamp } from '../responses';

export const APPROVAL_WORKFLOW_CATEGORIES = [
  'unpause',
  'treasury_payout_receiver_update',
  'oracle_update',
] as const satisfies readonly GovernanceActionCategory[];

type ApprovalWorkflowCategory = typeof APPROVAL_WORKFLOW_CATEGORIES[number];

const APPROVAL_REQUEST_METHODS: Record<ApprovalWorkflowCategory, string> = {
  unpause: 'proposeUnpause',
  treasury_payout_receiver_update: 'proposeTreasuryPayoutAddressUpdate',
  oracle_update: 'proposeOracleUpdate',
};

const APPROVAL_REVIEW_METHODS: Record<ApprovalWorkflowCategory, readonly string[]> = {
  unpause: ['approveUnpause', 'cancelUnpauseProposal'],
  treasury_payout_receiver_update: [
    'approveTreasuryPayoutAddressUpdate',
    'executeTreasuryPayoutAddressUpdate',
    'cancelExpiredTreasuryPayoutAddressUpdateProposal',
  ],
  oracle_update: [
    'approveOracleUpdate',
    'executeOracleUpdate',
    'cancelExpiredOracleUpdateProposal',
  ],
};

const TERMINAL_STATUSES = new Set<GovernanceActionStatus>([
  'executed',
  'cancelled',
  'expired',
  'stale',
  'failed',
]);

function isApprovalWorkflowCategory(category: GovernanceActionCategory): category is ApprovalWorkflowCategory {
  return (APPROVAL_WORKFLOW_CATEGORIES as readonly string[]).includes(category);
}

function isApprovalWorkflowRequest(action: GovernanceActionRecord): action is GovernanceActionRecord & {
  category: ApprovalWorkflowCategory;
} {
  return isApprovalWorkflowCategory(action.category)
    && action.contractMethod === APPROVAL_REQUEST_METHODS[action.category];
}

function isReviewMethod(category: ApprovalWorkflowCategory, contractMethod: string): boolean {
  return APPROVAL_REVIEW_METHODS[category].includes(contractMethod);
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  values.forEach((value) => {
    const parsed = parseTimestamp(value);
    if (parsed > latestMs && value) {
      latestMs = parsed;
      latestValue = value;
    }
  });

  return latestValue;
}

function sortActionsDesc(actions: GovernanceActionRecord[]): GovernanceActionRecord[] {
  return [...actions].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return right.actionId.localeCompare(left.actionId);
    }

    return right.createdAt.localeCompare(left.createdAt);
  });
}

function deriveReviewType(contractMethod: string): 'approve' | 'execute' | 'cancel' | 'other' {
  if (contractMethod.startsWith('approve')) {
    return 'approve';
  }

  if (contractMethod.startsWith('execute')) {
    return 'execute';
  }

  if (contractMethod.startsWith('cancel')) {
    return 'cancel';
  }

  return 'other';
}

function deriveApprovedBy(
  requestAction: GovernanceActionRecord,
  relatedActions: GovernanceActionRecord[],
): string[] {
  const identities = new Set<string>(requestAction.audit.approvedBy ?? []);

  relatedActions
    .filter((action) => deriveReviewType(action.contractMethod) === 'approve')
    .forEach((action) => {
      if (action.audit.requestedBy) {
        identities.add(action.audit.requestedBy);
      }
    });

  return [...identities];
}

function selectExecutionAction(
  requestAction: GovernanceActionRecord,
  relatedActions: GovernanceActionRecord[],
  status: GovernanceActionStatus,
): GovernanceActionRecord {
  const relatedExecution = sortActionsDesc(
    relatedActions.filter((action) => {
      const reviewType = deriveReviewType(action.contractMethod);
      if (reviewType === 'execute') {
        return true;
      }

      return requestAction.category === 'unpause'
        && reviewType === 'approve'
        && status === 'executed';
    }),
  )[0];

  return relatedExecution ?? requestAction;
}

function nextCursorFromItems(items: GovernanceActionRecord[], limit: number): string | null {
  if (items.length <= limit) {
    return null;
  }

  const boundary = items[limit - 1];
  return encodeGovernanceActionCursor({
    createdAt: boundary.createdAt,
    actionId: boundary.actionId,
  });
}

function proposalStateToStatus(
  proposal: GovernanceProposalState | null,
  approvalsRequired: number,
  fallback: GovernanceActionStatus,
): { status: GovernanceActionStatus; approvalCount: number | null; pendingExecution: boolean } {
  if (!proposal) {
    return {
      status: fallback,
      approvalCount: null,
      pendingExecution: fallback === 'approved',
    };
  }

  if (proposal.executed) {
    return {
      status: 'executed',
      approvalCount: proposal.approvalCount,
      pendingExecution: false,
    };
  }

  if (proposal.cancelled) {
    return {
      status: 'cancelled',
      approvalCount: proposal.approvalCount,
      pendingExecution: false,
    };
  }

  if (proposal.expired) {
    return {
      status: 'expired',
      approvalCount: proposal.approvalCount,
      pendingExecution: false,
    };
  }

  if (proposal.approvalCount >= approvalsRequired) {
    return {
      status: 'approved',
      approvalCount: proposal.approvalCount,
      pendingExecution: true,
    };
  }

  return {
    status: 'pending_approvals',
    approvalCount: proposal.approvalCount,
    pendingExecution: false,
  };
}

export interface ApprovalWorkflowFreshness {
  sourceFreshAt: string | null;
  queriedAt: string;
  available: boolean;
  degradedReason?: string;
}

export interface ApprovalWorkflowRequestMetadata {
  actionId: string;
  requestId: string;
  correlationId: string | null;
  requestedAt: string;
  requestedBy: string;
  actorWallet: string;
  actorRole: string;
  reason: string;
  ticketRef: string;
  evidenceLinks: GovernanceActionRecord['audit']['evidenceLinks'];
}

export interface ApprovalWorkflowReviewEvent {
  actionId: string;
  reviewType: 'approve' | 'execute' | 'cancel' | 'other';
  contractMethod: string;
  status: GovernanceActionStatus;
  reviewedAt: string;
  reviewedBy: string;
  actorWallet: string;
  actorRole: string;
  requestId: string;
  correlationId: string | null;
  executedAt: string | null;
  txHash: string | null;
  blockNumber: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ApprovalWorkflowSummary {
  approvalId: string;
  category: ApprovalWorkflowCategory;
  request: ApprovalWorkflowRequestMetadata;
  review: {
    approvalsRequired: number | null;
    approvalCount: number | null;
    approvedBy: string[];
    latestReviewedAt: string | null;
  };
  status: {
    current: GovernanceActionStatus;
    proposalId: number | null;
    expiresAt: string | null;
    executedAt: string | null;
    pendingExecution: boolean;
  };
  execution: {
    actionId: string;
    contractMethod: string;
    targetAddress: string | null;
    txHash: string | null;
    blockNumber: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
}

export interface ApprovalWorkflowDetail extends ApprovalWorkflowSummary {
  review: ApprovalWorkflowSummary['review'] & {
    items: ApprovalWorkflowReviewEvent[];
  };
}

export interface ListApprovalWorkflowsInput {
  category?: ApprovalWorkflowCategory;
  limit: number;
  cursor?: string;
}

export interface ListApprovalWorkflowsResult extends ApprovalWorkflowFreshness {
  items: ApprovalWorkflowSummary[];
  nextCursor: string | null;
}

export interface ApprovalWorkflowReadService {
  list(input: ListApprovalWorkflowsInput): Promise<ListApprovalWorkflowsResult>;
  get(approvalId: string): Promise<(ApprovalWorkflowDetail & ApprovalWorkflowFreshness) | null>;
}

type LiveResolution =
  | {
      available: true;
      governanceStatus: GovernanceStatusSnapshot;
      sourceFreshAt: string;
    }
  | {
      available: false;
      degradedReason: string;
      sourceFreshAt: string | null;
    };

export class GovernanceApprovalWorkflowReadService implements ApprovalWorkflowReadService {
  constructor(
    private readonly actionStore: GovernanceActionStore,
    private readonly governanceReader: GovernanceMutationPreflightReader,
  ) {}

  async list(input: ListApprovalWorkflowsInput): Promise<ListApprovalWorkflowsResult> {
    const queriedAt = isoTimestamp();
    const categories = input.category ? [input.category] : APPROVAL_WORKFLOW_CATEGORIES;

    if (input.cursor) {
      decodeGovernanceActionCursor(input.cursor);
    }

    const categoryPages = await Promise.all(categories.map((category) => (
      this.actionStore.list({
        category,
        limit: input.limit + 1,
        cursor: input.cursor,
      })
    )));

    const merged = sortActionsDesc(categoryPages.flatMap((page) => page.items))
      .filter(isApprovalWorkflowRequest);

    const selected = merged.slice(0, input.limit);
    const live = await this.resolveGovernanceSnapshot(queriedAt);
    const summaries = await Promise.all(selected.map((action) => this.buildSummary(action, live)));
    const degradedReason = live.available
      ? summaries.map((entry) => entry.degradedReason).find((value): value is string => Boolean(value))
      : live.degradedReason;

    return {
      items: summaries.map((entry) => entry.summary),
      nextCursor: nextCursorFromItems(merged, input.limit),
      queriedAt,
      available: degradedReason ? false : live.available,
      sourceFreshAt: live.sourceFreshAt,
      ...(degradedReason ? { degradedReason } : {}),
    };
  }

  async get(approvalId: string): Promise<(ApprovalWorkflowDetail & ApprovalWorkflowFreshness) | null> {
    const queriedAt = isoTimestamp();
    const action = await this.actionStore.get(approvalId);
    if (!action || !isApprovalWorkflowRequest(action)) {
      return null;
    }

    const relatedActions = await this.listRelatedActions(action);
    const live = await this.resolveGovernanceSnapshot(queriedAt);
    const detail = await this.buildDetail(action, relatedActions, live);

    const responseDegradedReason = detail.degradedReason ?? (!live.available ? live.degradedReason : undefined);

    return {
      ...detail.detail,
      queriedAt,
      available: detail.degradedReason ? false : live.available,
      sourceFreshAt: latestTimestamp([
        live.sourceFreshAt,
        detail.detail.request.requestedAt,
        detail.detail.review.latestReviewedAt,
        detail.detail.status.executedAt,
      ]),
      ...(responseDegradedReason ? { degradedReason: responseDegradedReason } : {}),
    };
  }

  private async resolveGovernanceSnapshot(queriedAt: string): Promise<LiveResolution> {
    try {
      const governanceStatus = await this.governanceReader.getGovernanceStatus();
      return {
        available: true,
        governanceStatus,
        sourceFreshAt: queriedAt,
      };
    } catch (error) {
      return {
        available: false,
        degradedReason: error instanceof Error ? error.message : String(error),
        sourceFreshAt: null,
      };
    }
  }

  private async buildSummary(
    action: GovernanceActionRecord & { category: ApprovalWorkflowCategory },
    live: LiveResolution,
    relatedActionsInput?: GovernanceActionRecord[],
  ): Promise<{ summary: ApprovalWorkflowSummary; degradedReason?: string }> {
    const relatedActions = relatedActionsInput ?? await this.listRelatedActions(action);
    const workflowState = await this.resolveWorkflowState(action, live, relatedActions);
    const executionAction = selectExecutionAction(action, relatedActions, workflowState.currentStatus);

    return {
      summary: {
        approvalId: action.actionId,
        category: action.category,
        request: {
          actionId: action.actionId,
          requestId: action.requestId,
          correlationId: action.correlationId,
          requestedAt: action.createdAt,
          requestedBy: action.audit.requestedBy,
          actorWallet: action.audit.actorWallet,
          actorRole: action.audit.actorRole,
          reason: action.audit.reason,
          ticketRef: action.audit.ticketRef,
          evidenceLinks: action.audit.evidenceLinks,
        },
        review: {
          approvalsRequired: workflowState.approvalsRequired,
          approvalCount: workflowState.approvalCount,
          approvedBy: workflowState.approvedBy,
          latestReviewedAt: latestTimestamp(relatedActions.map((candidate) => candidate.createdAt)),
        },
        status: {
          current: workflowState.currentStatus,
          proposalId: action.proposalId,
          expiresAt: action.expiresAt,
          executedAt: executionAction.executedAt,
          pendingExecution: workflowState.pendingExecution,
        },
        execution: {
          actionId: executionAction.actionId,
          contractMethod: executionAction.contractMethod,
          targetAddress: executionAction.targetAddress,
          txHash: executionAction.txHash,
          blockNumber: executionAction.blockNumber,
          errorCode: executionAction.errorCode,
          errorMessage: executionAction.errorMessage,
        },
      },
      ...(workflowState.degradedReason ? { degradedReason: workflowState.degradedReason } : {}),
    };
  }

  private async buildDetail(
    action: GovernanceActionRecord & { category: ApprovalWorkflowCategory },
    relatedActions: GovernanceActionRecord[],
    live: LiveResolution,
  ): Promise<{ detail: ApprovalWorkflowDetail; degradedReason?: string }> {
    const summary = await this.buildSummary(action, live, relatedActions);
    const items = sortActionsDesc(relatedActions).map((candidate) => ({
      actionId: candidate.actionId,
      reviewType: deriveReviewType(candidate.contractMethod),
      contractMethod: candidate.contractMethod,
      status: candidate.status,
      reviewedAt: candidate.createdAt,
      reviewedBy: candidate.audit.requestedBy,
      actorWallet: candidate.audit.actorWallet,
      actorRole: candidate.audit.actorRole,
      requestId: candidate.requestId,
      correlationId: candidate.correlationId,
      executedAt: candidate.executedAt,
      txHash: candidate.txHash,
      blockNumber: candidate.blockNumber,
      errorCode: candidate.errorCode,
      errorMessage: candidate.errorMessage,
    }));

    return {
      detail: {
        ...summary.summary,
        review: {
          ...summary.summary.review,
          items,
        },
      },
      ...(summary.degradedReason ? { degradedReason: summary.degradedReason } : {}),
    };
  }

  private async resolveWorkflowState(
    requestAction: GovernanceActionRecord & { category: ApprovalWorkflowCategory },
    live: LiveResolution,
    relatedActions: GovernanceActionRecord[],
  ): Promise<{
    approvalsRequired: number | null;
    approvalCount: number | null;
    approvedBy: string[];
    currentStatus: GovernanceActionStatus;
    pendingExecution: boolean;
    degradedReason?: string;
  }> {
    const approvedBy = deriveApprovedBy(requestAction, relatedActions);
    const fallbackStatus = requestAction.status;

    if (!live.available) {
      return {
        approvalsRequired: null,
        approvalCount: approvedBy.length > 0 ? approvedBy.length : requestAction.audit.approvedBy?.length ?? null,
        approvedBy,
        currentStatus: fallbackStatus,
        pendingExecution: fallbackStatus === 'approved',
      };
    }

    if (TERMINAL_STATUSES.has(fallbackStatus)) {
      return {
        approvalsRequired: live.governanceStatus.governanceApprovalsRequired,
        approvalCount: approvedBy.length,
        approvedBy,
        currentStatus: fallbackStatus,
        pendingExecution: false,
      };
    }

    try {
      if (requestAction.category === 'unpause') {
        const proposal = await this.governanceReader.getUnpauseProposalState();
        if (!proposal.hasActiveProposal && !live.governanceStatus.paused) {
          return {
            approvalsRequired: live.governanceStatus.governanceApprovalsRequired,
            approvalCount: proposal.approvalCount,
            approvedBy,
            currentStatus: 'executed',
            pendingExecution: false,
          };
        }

        const currentStatus = proposal.approvalCount >= live.governanceStatus.governanceApprovalsRequired
          ? 'approved'
          : 'pending_approvals';

        return {
          approvalsRequired: live.governanceStatus.governanceApprovalsRequired,
          approvalCount: proposal.approvalCount,
          approvedBy,
          currentStatus,
          pendingExecution: currentStatus === 'approved',
        };
      }

      const proposal = requestAction.category === 'oracle_update'
        ? await this.governanceReader.getOracleProposalState(requestAction.proposalId ?? -1)
        : await this.governanceReader.getTreasuryPayoutReceiverProposalState(requestAction.proposalId ?? -1);

      const proposalResolution = proposalStateToStatus(
        proposal,
        live.governanceStatus.governanceApprovalsRequired,
        fallbackStatus,
      );

      return {
        approvalsRequired: live.governanceStatus.governanceApprovalsRequired,
        approvalCount: proposalResolution.approvalCount,
        approvedBy,
        currentStatus: proposalResolution.status,
        pendingExecution: proposalResolution.pendingExecution,
      };
    } catch (error) {
      return {
        approvalsRequired: live.governanceStatus.governanceApprovalsRequired,
        approvalCount: approvedBy.length,
        approvedBy,
        currentStatus: fallbackStatus,
        pendingExecution: fallbackStatus === 'approved',
        degradedReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async listRelatedActions(
    requestAction: GovernanceActionRecord & { category: ApprovalWorkflowCategory },
  ): Promise<GovernanceActionRecord[]> {
    const categoryActions = await this.actionStore.list({
      category: requestAction.category,
      limit: 200,
    });

    const requestMethod = APPROVAL_REQUEST_METHODS[requestAction.category];
    const newerRequestBoundary = categoryActions.items
      .filter((candidate) => (
        candidate.actionId !== requestAction.actionId
        && candidate.contractMethod === requestMethod
        && (
          candidate.createdAt > requestAction.createdAt
          || (candidate.createdAt === requestAction.createdAt && candidate.actionId > requestAction.actionId)
        )
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.actionId.localeCompare(right.actionId))[0];

    return categoryActions.items.filter((candidate) => {
      if (candidate.actionId === requestAction.actionId) {
        return false;
      }

      if (!isReviewMethod(requestAction.category, candidate.contractMethod)) {
        return false;
      }

      if (requestAction.proposalId !== null) {
        return candidate.proposalId === requestAction.proposalId;
      }

      const lowerBound = candidate.createdAt >= requestAction.createdAt;
      const upperBound = newerRequestBoundary
        ? (
          candidate.createdAt < newerRequestBoundary.createdAt
          || (candidate.createdAt === newerRequestBoundary.createdAt && candidate.actionId < newerRequestBoundary.actionId)
        )
        : true;

      return lowerBound && upperBound;
    });
  }
}

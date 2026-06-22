/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Operator-supplied audit context shared by privileged mutations (compliance
 * decisions, evidence bundles). Kept independent of any single store so the
 * audit shape outlives individual feature modules.
 */

export interface EvidenceLink {
  kind:
    | 'runbook'
    | 'incident'
    | 'ticket'
    | 'tx'
    | 'event'
    | 'document'
    | 'log'
    | 'dashboard'
    | 'other';
  uri: string;
  note?: string;
}

/**
 * Operator-supplied audit context attached to a privileged mutation
 * (reason, supporting evidence links, and a tracking ticket reference).
 */
export interface GovernanceMutationAuditInput {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
}

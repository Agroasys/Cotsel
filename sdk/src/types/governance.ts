/**
 * SPDX-License-Identifier: Apache-2.0
 */
export interface OracleUpdateProposal {
  proposalId: string;
  newOracle: string;
  approvalCount: number;
  executed: boolean;
  createdAt: Date;
  eta: bigint;
  proposer: string;
}

export enum PauseScope {
  GLOBAL = 0,
  CLAIMS = 1,
  TRADE = 2,
}

export enum AdminChangeKind {
  ADD = 0,
  REMOVE = 1,
  REPLACE = 2,
  THRESHOLD = 3,
  RELAYER_ADD = 4,
  RELAYER_REMOVE = 5,
}

export interface AdminChangeProposal {
  proposalId: string;
  kind: AdminChangeKind;
  currentAdmin: string;
  newAdmin: string;
  newThreshold: number;
  approvalCount: number;
  executed: boolean;
  createdAt: Date;
  eta: bigint;
  proposer: string;
  epoch: bigint;
}

export interface GovernanceResult {
  txHash: string;
  blockNumber: number;
}

export interface GovernanceProposalResult extends GovernanceResult {
  proposalId?: bigint;
}

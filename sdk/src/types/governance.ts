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

export interface AdminAddProposal {
    proposalId: string;
    newAdmin: string;
    approvalCount: number;
    executed: boolean;
    createdAt: Date;
    eta: bigint;
    proposer: string;
}

export interface GovernanceResult {
    txHash: string;
    blockNumber: number;
}

export interface GovernanceProposalResult extends GovernanceResult {
    proposalId?: bigint;
}

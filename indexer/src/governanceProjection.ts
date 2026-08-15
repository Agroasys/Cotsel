export interface ExecutableGovernanceProposal {
  executed: boolean;
}

export function markGovernanceProposalExecuted<T extends ExecutableGovernanceProposal>(
  proposals: Map<string, T>,
  proposalId: string,
  proposal: T,
): T {
  proposal.executed = true;
  proposals.set(proposalId, proposal);
  return proposal;
}

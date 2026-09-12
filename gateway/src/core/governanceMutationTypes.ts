/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  EvidenceLink,
  GovernanceActionCategory,
  GovernanceMonitoringState,
  GovernancePreparedSigningPayload,
  GovernanceVerificationState,
} from './governanceStore';
import type { GatewayPrincipal } from '../middleware/auth';
import type { AuthorizedSignerBinding } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';

export interface GovernanceMutationAuditInput {
  reason: string;
  evidenceLinks: EvidenceLink[];
  ticketRef: string;
}

export interface GovernanceActionPrepared {
  actionId: string;
  intentKey: string;
  proposalId: number | null;
  category: GovernanceActionCategory;
  status: 'prepared' | 'broadcast_pending_verification' | 'broadcast';
  preparedAt: string;
  expiresAt: string | null;
  signing: GovernancePreparedSigningPayload;
}

export interface GovernanceBroadcastConfirmed {
  actionId: string;
  txHash: string;
  status: 'broadcast' | 'broadcast_pending_verification';
  broadcastAt: string;
  signerWallet: string | null;
  verificationState: GovernanceVerificationState;
  monitoringState: GovernanceMonitoringState;
  verifiedAt: string | null;
  blockNumber: number | null;
}

export interface PrepareGovernanceActionInput {
  category: GovernanceActionCategory;
  contractMethod: string;
  routePath: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  audit: GovernanceMutationAuditInput;
  principal: GatewayPrincipal;
  signerWallet: string;
  signerBinding: AuthorizedSignerBinding;
  requestContext: RequestContext;
  idempotencyKey: string;
}

export interface ConfirmGovernanceBroadcastInput {
  actionId: string;
  txHash: string;
  signerWallet: string;
  principal: GatewayPrincipal;
  signerBinding: AuthorizedSignerBinding;
  requestContext: RequestContext;
}

export interface GovernanceObservedTransaction {
  chainId: number | null;
  to: string | null;
  from: string | null;
  data: string | null;
  value: string | null;
  nonce: number | null;
  blockNumber: number | null;
}

export interface GovernanceObservedTransactionReceipt {
  blockNumber: number | null;
  status: 'success' | 'reverted' | 'unknown';
}

export interface GovernanceTransactionVerifier {
  getTransactionCount(walletAddress: string): Promise<number>;
  getTransaction(txHash: string): Promise<GovernanceObservedTransaction | null>;
  getTransactionReceipt(txHash: string): Promise<GovernanceObservedTransactionReceipt | null>;
  getBlockNumber(): Promise<number | null>;
}

export interface GovernanceVerificationOutcome {
  status: 'broadcast' | 'broadcast_pending_verification';
  verificationState: GovernanceVerificationState;
  monitoringState: GovernanceMonitoringState;
  finalSignerWallet: string | null;
  verificationError: string | null;
  verifiedAt: string | null;
  blockNumber: number | null;
}

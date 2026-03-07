/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { JsonRpcProvider, Wallet } from 'ethers';
import { AdminSDK, type GovernanceProposalResult } from '@agroasys/sdk';
import { GovernanceExecutorConfig } from '../config/executorEnv';
import { GatewayError } from '../errors';
import { GovernanceActionRecord } from '../core/governanceStore';
import {
  GovernanceChainExecutor,
  GovernanceExecutionResult,
} from './governanceExecutor';

function toSafeNumber(value: bigint | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Proposal id exceeds safe integer range');
  }

  return numeric;
}

function requireProposalId(action: GovernanceActionRecord, message: string): bigint {
  if (action.proposalId === null) {
    throw new GatewayError(500, 'INTERNAL_ERROR', message);
  }

  return BigInt(action.proposalId);
}

function requireTargetAddress(action: GovernanceActionRecord, message: string): string {
  if (!action.targetAddress) {
    throw new GatewayError(500, 'INTERNAL_ERROR', message);
  }

  return action.targetAddress;
}

function toProposalResult(execution: GovernanceProposalResult, missingProposalMessage: string): GovernanceExecutionResult {
  const proposalId = toSafeNumber(execution.proposalId);
  if (proposalId === null) {
    throw new GatewayError(500, 'INTERNAL_ERROR', missingProposalMessage);
  }

  return {
    txHash: execution.txHash,
    blockNumber: execution.blockNumber,
    proposalId,
  };
}

export function createAdminSdkGovernanceChainExecutor(config: GovernanceExecutorConfig): GovernanceChainExecutor {
  const adminSdk = new AdminSDK({
    rpc: config.rpcUrl,
    chainId: config.chainId,
    escrowAddress: config.escrowAddress,
    usdcAddress: config.usdcAddress,
  });
  const signer = new Wallet(config.executorPrivateKey, new JsonRpcProvider(config.rpcUrl));

  return {
    async getSignerAddress() {
      return signer.getAddress();
    },

    async execute(action) {
      switch (action.contractMethod) {
        case 'pause':
          return adminSdk.pause(signer);
        case 'proposeUnpause':
          return adminSdk.proposeUnpause(signer);
        case 'approveUnpause':
          return adminSdk.approveUnpause(signer);
        case 'cancelUnpauseProposal':
          return adminSdk.cancelUnpauseProposal(signer);
        case 'pauseClaims':
          return adminSdk.pauseClaims(signer);
        case 'unpauseClaims':
          return adminSdk.unpauseClaims(signer);
        case 'claimTreasury':
          return adminSdk.claimTreasury(signer);
        case 'proposeTreasuryPayoutAddressUpdate': {
          const result = await adminSdk.proposeTreasuryPayoutAddressUpdate(
            requireTargetAddress(action, 'Queued treasury payout receiver action is missing targetAddress'),
            signer,
          );
          return toProposalResult(result, 'Treasury payout receiver proposal execution did not return a proposal id');
        }
        case 'approveTreasuryPayoutAddressUpdate':
          return adminSdk.approveTreasuryPayoutAddressUpdate(
            requireProposalId(action, 'Queued treasury payout receiver approval is missing proposalId'),
            signer,
          );
        case 'executeTreasuryPayoutAddressUpdate':
          return adminSdk.executeTreasuryPayoutAddressUpdate(
            requireProposalId(action, 'Queued treasury payout receiver execution is missing proposalId'),
            signer,
          );
        case 'cancelExpiredTreasuryPayoutAddressUpdateProposal':
          return adminSdk.cancelExpiredTreasuryPayoutAddressUpdateProposal(
            requireProposalId(action, 'Queued treasury payout receiver cancellation is missing proposalId'),
            signer,
          );
        case 'disableOracleEmergency':
          return adminSdk.disableOracleEmergency(signer);
        case 'proposeOracleUpdate': {
          const result = await adminSdk.proposeOracleUpdate(
            requireTargetAddress(action, 'Queued oracle update action is missing targetAddress'),
            signer,
          );
          return toProposalResult(result, 'Oracle proposal execution did not return a proposal id');
        }
        case 'approveOracleUpdate':
          return adminSdk.approveOracleUpdate(
            requireProposalId(action, 'Queued oracle approval is missing proposalId'),
            signer,
          );
        case 'executeOracleUpdate':
          return adminSdk.executeOracleUpdate(
            requireProposalId(action, 'Queued oracle execution is missing proposalId'),
            signer,
          );
        case 'cancelExpiredOracleUpdateProposal':
          return adminSdk.cancelExpiredOracleUpdateProposal(
            requireProposalId(action, 'Queued oracle cancellation is missing proposalId'),
            signer,
          );
        default:
          throw new GatewayError(500, 'INTERNAL_ERROR', 'Unsupported governance contract method for executor', {
            contractMethod: action.contractMethod,
          });
      }
    },
  };
}

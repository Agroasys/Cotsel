/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { AgroasysEscrow__factory } from '../typechain-types';

describe('AgroasysEscrow event schema', function () {
  it('keeps the Base-era event ABI stable for downstream consumers', async function () {
    const signatures = AgroasysEscrow__factory.createInterface()
      .fragments.filter((fragment) => fragment.type === 'event')
      .map((fragment) => fragment.format('sighash'))
      .sort();

    expect(signatures).to.deep.equal([
      'AdminAddApproved(uint256,address,uint256,uint256)',
      'AdminAddProposalExpiredCancelled(uint256,address)',
      'AdminAddProposed(uint256,address,address,uint256)',
      'AdminAdded(address)',
      'AuthorizationConsumed(address,bytes32,uint256,address,uint256)',
      'BuyerRefundTransferred(uint256,address,uint256,uint8,address)',
      'ClaimableAccrued(uint256,address,uint256,uint8)',
      'ClaimsPaused(address)',
      'ClaimsUnpaused(address)',
      'DisputeApproved(uint256,address,uint256,uint256)',
      'DisputeFinalized(uint256,uint256,uint8)',
      'DisputeOpenedByBuyer(uint256)',
      'DisputePayout(uint256,uint256,address,uint256,uint8)',
      'DisputeProposalExpiredCancelled(uint256,uint256,address)',
      'DisputeSolutionProposed(uint256,uint256,uint8,address)',
      'FinalTrancheReleased(uint256,address,uint256)',
      'FundsReleasedStage1(uint256,address,uint256,address,uint256)',
      'GaslessTradeFunded(uint256,address,bytes32,uint256)',
      'InTransitTimeoutRefunded(uint256,address,uint256)',
      'InspectionAcceptedForFinalRelease(uint256,uint256)',
      'InspectionAvailable(uint256,uint256,uint256,uint256)',
      'OracleDisabledEmergency(address,address)',
      'OracleUpdateApproved(uint256,address,uint256,uint256)',
      'OracleUpdateProposalExpiredCancelled(uint256,address)',
      'OracleUpdateProposed(uint256,address,address,uint256,bool)',
      'OracleUpdated(address,address)',
      'Paused(address)',
      'PlatformFeesPaidStage1(uint256,address,uint256,uint256,uint256)',
      'RelayedActionExecuted(address,address,bytes32,uint256)',
      'RelayerUpdated(address,bool,address)',
      'SupplierPayoutTransferred(uint256,address,uint256,uint8,address)',
      'TradeCancelledAfterLockTimeout(uint256,address,uint256)',
      'TradeLocked(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)',
      'TreasuryClaimed(address,address,uint256,address)',
      'TreasuryPayoutAddressUpdateApproved(uint256,address,uint256,uint256)',
      'TreasuryPayoutAddressUpdateProposalExpiredCancelled(uint256,address)',
      'TreasuryPayoutAddressUpdateProposed(uint256,address,address,uint256)',
      'TreasuryPayoutAddressUpdated(address,address)',
      'UnpauseApproved(address,uint256,uint256)',
      'UnpauseProposalCancelled(address)',
      'UnpauseProposed(address)',
      'Unpaused(address)',
    ]);
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerExpiryBoundaryTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let operator1!: AgroasysEscrowHarness['operator1'];
  let openDisputeAsBuyer!: AgroasysEscrowHarness['openDisputeAsBuyer'];
  let createDefaultTrade!: AgroasysEscrowHarness['createDefaultTrade'];

  describe('Expiry Edge Boundaries', function () {
    beforeEach(function () {
      ({
        escrow,
        buyer,
        oracle,
        admin1,
        admin2,
        operator1,
        openDisputeAsBuyer,
        createDefaultTrade,
      } = getHarness());
    });
    it('Should allow dispute approval exactly at dispute TTL boundary', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('dispute-expiry-boundary-ok'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await openDisputeAsBuyer(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const proposal = await escrow.disputeProposals(0);
      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.setNextBlockTimestamp(proposal.createdAt + ttl);

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, 'DisputeFinalized')
        .withArgs(0, tradeId, 0);
    });

    it('Should reject dispute approval one second after dispute TTL boundary', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('dispute-expiry-boundary-fail'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await openDisputeAsBuyer(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const proposal = await escrow.disputeProposals(0);
      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.setNextBlockTimestamp(proposal.createdAt + ttl + 1n);

      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalExpired',
      );
    });

    it('Should allow oracle governance execution exactly at governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(operator1.address);
      await escrow.connect(admin2).approveOracleUpdate(0);

      const expiresAt = await escrow.oracleUpdateProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt);

      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, 'OracleUpdated')
        .withArgs(oracle.address, operator1.address);
    });

    it('Should reject oracle governance execution one second after governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(operator1.address);
      await escrow.connect(admin2).approveOracleUpdate(0);

      const expiresAt = await escrow.oracleUpdateProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt + 1n);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalExpired',
      );
    });

    it('Should allow add-admin governance execution exactly at governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, buyer.address, 0);
      await escrow.connect(admin2).approveAdminChange(0);

      const proposal = await escrow.adminChangeProposals(0);
      const expiresAt = proposal.createdAt + (await escrow.GOVERNANCE_PROPOSAL_TTL());
      await time.setNextBlockTimestamp(expiresAt);

      await expect(escrow.connect(admin1).executeAdminChange(0))
        .to.emit(escrow, 'AdminAdded')
        .withArgs(buyer.address);
    });

    it('Should reject add-admin governance execution one second after governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, buyer.address, 0);
      await escrow.connect(admin2).approveAdminChange(0);

      const proposal = await escrow.adminChangeProposals(0);
      const expiresAt = proposal.createdAt + (await escrow.GOVERNANCE_PROPOSAL_TTL());
      await time.setNextBlockTimestamp(expiresAt + 1n);

      await expect(escrow.connect(admin1).executeAdminChange(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalExpired',
      );
    });
  });
}

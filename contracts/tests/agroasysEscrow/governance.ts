/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerGovernanceTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let admin3!: AgroasysEscrowHarness['admin3'];
  let operator1!: AgroasysEscrowHarness['operator1'];
  let operator2!: AgroasysEscrowHarness['operator2'];
  let createDefaultTrade!: AgroasysEscrowHarness['createDefaultTrade'];
  let rotateTreasuryPayoutReceiver!: AgroasysEscrowHarness['rotateTreasuryPayoutReceiver'];

  describe('Governance: Oracle Update', function () {
    beforeEach(function () {
      ({
        escrow,
        buyer,
        treasury,
        oracle,
        admin1,
        admin2,
        admin3,
        operator1,
        operator2,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should update oracle with timelock', async function () {
      const newOracle = operator1.address;

      await escrow.connect(admin1).proposeOracleUpdate(newOracle);

      await escrow.connect(admin2).approveOracleUpdate(0);

      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, 'OracleUpdated')
        .withArgs(oracle.address, newOracle);

      expect(await escrow.oracleAddress()).to.equal(newOracle);
    });

    it('Should reject execution before timelock', async function () {
      const newOracle = operator1.address;

      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowTimelockNotElapsed',
      );
    });

    it('Should reject oracle update from non-admin', async function () {
      await expect(
        escrow.connect(buyer).proposeOracleUpdate(operator1.address),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');
    });

    it('Should reject execution after proposal expiry and allow cancel', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(operator1.address);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalExpired',
      );

      await expect(escrow.connect(admin2).cancelExpiredOracleUpdateProposal(0))
        .to.emit(escrow, 'OracleUpdateProposalExpiredCancelled')
        .withArgs(0, admin2.address);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalCancelled',
      );
    });
  });

  describe('Governance: Add Admin', function () {
    beforeEach(function () {
      ({
        escrow,
        buyer,
        treasury,
        oracle,
        admin1,
        admin2,
        admin3,
        operator1,
        operator2,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should add new admin with timelock', async function () {
      const newAdmin = buyer.address;

      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, newAdmin, 0);

      await escrow.connect(admin2).approveAdminChange(0);

      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(admin1).executeAdminChange(0))
        .to.emit(escrow, 'AdminAdded')
        .withArgs(newAdmin)
        .and.to.emit(escrow, 'AdminChangeExecuted')
        .withArgs(0, 0, ethers.ZeroAddress, newAdmin, 0);

      expect(await escrow.isAdmin(newAdmin)).to.be.true;
    });

    it('Should reject add admin from non-admin', async function () {
      await expect(
        escrow.connect(buyer).proposeAdminChange(0, ethers.ZeroAddress, buyer.address, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');
    });

    it('Should reject execution after proposal expiry and allow cancel', async function () {
      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, buyer.address, 0);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin1).executeAdminChange(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalExpired',
      );

      await expect(escrow.connect(admin2).cancelAdminChangeProposal(0))
        .to.emit(escrow, 'AdminChangeProposalCancelled')
        .withArgs(0, admin2.address);

      await expect(escrow.connect(admin1).executeAdminChange(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalCancelled',
      );
    });
  });

  describe('Governance: recoverable authority', function () {
    beforeEach(function () {
      ({
        escrow,
        buyer,
        treasury,
        oracle,
        admin1,
        admin2,
        admin3,
        operator1,
        operator2,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    async function approveAndExecuteAdminChange(proposalId: bigint | number) {
      await escrow.connect(admin2).approveAdminChange(proposalId);
      await time.increase(24 * 3600 + 1);
      return escrow.connect(admin1).executeAdminChange(proposalId);
    }

    it('atomically replaces a lost administrator and advances the governance epoch', async function () {
      const epoch = await escrow.governanceEpoch();
      await escrow.connect(admin1).proposeAdminChange(2, admin3.address, operator1.address, 0);

      await expect(approveAndExecuteAdminChange(0))
        .to.emit(escrow, 'AdminReplaced')
        .withArgs(admin3.address, operator1.address)
        .and.to.emit(escrow, 'GovernanceEpochAdvanced')
        .withArgs(epoch + 1n);

      expect(await escrow.isAdmin(admin3.address)).to.be.false;
      expect(await escrow.isAdmin(operator1.address)).to.be.true;
    });

    it('changes quorum only while preserving a spare administrator', async function () {
      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, operator1.address, 0);
      await approveAndExecuteAdminChange(0);

      await escrow.connect(admin1).proposeAdminChange(3, ethers.ZeroAddress, ethers.ZeroAddress, 3);
      await approveAndExecuteAdminChange(1);
      expect(await escrow.requiredApprovals()).to.equal(3);

      await expect(
        escrow.connect(admin1).proposeAdminChange(1, operator1.address, ethers.ZeroAddress, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowNotEnoughAdmins');
    });

    it('rotates relayers through the same quorum and timelock policy', async function () {
      await escrow.connect(admin1).proposeAdminChange(4, ethers.ZeroAddress, operator2.address, 0);
      await expect(approveAndExecuteAdminChange(0))
        .to.emit(escrow, 'RelayerUpdated')
        .withArgs(operator2.address, true, admin1.address);
      expect(await escrow.isRelayer(operator2.address)).to.be.true;

      await escrow.connect(admin1).proposeAdminChange(5, operator2.address, ethers.ZeroAddress, 0);
      await expect(approveAndExecuteAdminChange(1))
        .to.emit(escrow, 'RelayerUpdated')
        .withArgs(operator2.address, false, admin1.address);
      expect(await escrow.isRelayer(operator2.address)).to.be.false;
    });

    it('invalidates proposals approved under an older governance epoch', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(operator1.address);
      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, buyer.address, 0);
      await approveAndExecuteAdminChange(0);

      await expect(escrow.connect(admin2).approveOracleUpdate(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowStaleGovernanceProposal',
      );
    });

    it('rejects service-role overlap and requires an incident reference for recovery', async function () {
      await expect(
        escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, treasury.address, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidRoleSeparation');

      await escrow.connect(admin1).pauseClaims();
      await expect(
        escrow.connect(admin1).proposeUnpause(1, 0, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidIncidentReference');

      await escrow.connect(admin1).proposeUnpause(1, 0, ethers.id('incident-2026-08-15'));
      expect(await escrow.claimsPaused()).to.be.true;
      await escrow.connect(admin2).approveUnpause();
      expect(await escrow.claimsPaused()).to.be.false;
    });

    it('prevents an unrelated administrator from cancelling an active authority change', async function () {
      await escrow.connect(admin1).proposeAdminChange(2, admin3.address, operator1.address, 0);

      await expect(
        escrow.connect(admin3).cancelAdminChangeProposal(0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowProposalNotExpired');

      await approveAndExecuteAdminChange(0);
      expect(await escrow.isAdmin(operator1.address)).to.be.true;
    });
  });

  describe('Governance: Treasury Payout Receiver', function () {
    beforeEach(function () {
      ({
        escrow,
        buyer,
        treasury,
        oracle,
        admin1,
        admin2,
        admin3,
        operator1,
        operator2,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should rotate treasury payout receiver with quorum and timelock', async function () {
      const newReceiver = operator2.address;

      await expect(
        escrow.connect(buyer).proposeTreasuryPayoutAddressUpdate(newReceiver),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');

      await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(newReceiver);
      await expect(
        escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowNotEnoughApprovals');

      await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(0);
      await expect(
        escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTimelockNotElapsed');

      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0))
        .to.emit(escrow, 'TreasuryPayoutAddressUpdated')
        .withArgs(treasury.address, newReceiver);

      expect(await escrow.treasuryPayoutAddress()).to.equal(newReceiver);
    });

    it('Should reject invalid treasury payout receiver update proposals', async function () {
      await expect(
        escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidTreasuryPayoutReceiver');

      await expect(
        escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(treasury.address),
      ).to.be.revertedWithCustomError(escrow, 'EscrowSameTreasuryPayoutReceiver');
    });

    it('Should reject execution after proposal expiry and allow cancel', async function () {
      await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(operator2.address);
      await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(0);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(
        escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowProposalExpired');

      await expect(escrow.connect(admin2).cancelExpiredTreasuryPayoutAddressUpdateProposal(0))
        .to.emit(escrow, 'TreasuryPayoutAddressUpdateProposalExpiredCancelled')
        .withArgs(0, admin2.address);

      await expect(
        escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowProposalCancelled');
    });

    it('Should keep trade signature flow valid after payout receiver rotation', async function () {
      await rotateTreasuryPayoutReceiver(operator2.address);
      const { tradeId } = await createDefaultTrade(ethers.id('sig-valid-after-payout-rotation'));
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(0); // LOCKED
      expect(await escrow.treasuryPayoutAddress()).to.equal(operator2.address);
      expect(await escrow.treasuryAddress()).to.equal(treasury.address);
    });
  });
}

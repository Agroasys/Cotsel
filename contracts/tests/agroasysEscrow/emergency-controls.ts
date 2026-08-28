/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerEmergencyControlTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let relayer!: AgroasysEscrowHarness['relayer'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let admin3!: AgroasysEscrowHarness['admin3'];
  let operator1!: AgroasysEscrowHarness['operator1'];
  let cancelLockedTradeAfterTimeoutAsBuyer!: AgroasysEscrowHarness['cancelLockedTradeAfterTimeoutAsBuyer'];
  let createDefaultTrade!: AgroasysEscrowHarness['createDefaultTrade'];
  let unpauseWithQuorum!: AgroasysEscrowHarness['unpauseWithQuorum'];
  let unpauseClaimsWithQuorum!: AgroasysEscrowHarness['unpauseClaimsWithQuorum'];

  describe('Emergency Controls', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        treasury,
        oracle,
        relayer,
        admin1,
        admin2,
        admin3,
        operator1,
        cancelLockedTradeAfterTimeoutAsBuyer,
        createDefaultTrade,
        unpauseWithQuorum,
        unpauseClaimsWithQuorum,
      } = getHarness());
    });
    it('Should pause/unpause and block normal state transitions while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('pause-trade'));

      await expect(escrow.connect(admin1).pause())
        .to.emit(escrow, 'Paused')
        .withArgs(admin1.address);

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowPaused');

      await escrow.connect(admin1).proposeUnpause(0, 0, ethers.id('test-recovery'));
      await expect(escrow.connect(admin2).approveUnpause())
        .to.emit(escrow, 'Unpaused')
        .withArgs(admin2.address);

      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId)).to.emit(
        escrow,
        'FundsReleasedStage1',
      );
    });

    it('Should emit the configured governance quorum during unpause', async function () {
      const EscrowFactory = await ethers.getContractFactory('AgroasysEscrow');
      const quorumEscrow = await EscrowFactory.deploy(
        await usdc.getAddress(),
        oracle.address,
        treasury.address,
        relayer.address,
        [admin1.address, admin2.address, admin3.address],
        2,
      );
      await quorumEscrow.waitForDeployment();

      await expect(quorumEscrow.connect(admin1).pause())
        .to.emit(quorumEscrow, 'Paused')
        .withArgs(admin1.address);

      await expect(quorumEscrow.connect(admin1).proposeUnpause(0, 0, ethers.id('test-recovery')))
        .to.emit(quorumEscrow, 'UnpauseApproved')
        .withArgs(admin1.address, 1, 2);

      await expect(quorumEscrow.connect(admin2).approveUnpause())
        .to.emit(quorumEscrow, 'UnpauseApproved')
        .withArgs(admin2.address, 2, 2)
        .and.to.emit(quorumEscrow, 'Unpaused')
        .withArgs(admin2.address);
    });

    it('Should direct-transfer buyer refund before global pause', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id('pause-refund-flow'));
      const buyerBalBefore = await usdc.balanceOf(buyer.address);
      await time.increase(7 * 24 * 3600 + 1);
      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId))
        .to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, totalAmount, 4, admin1.address);

      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + totalAmount);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);

      await escrow.connect(admin1).pause();
    });

    it('Should keep buyer refunds automatic even when treasury claims are paused', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(
        ethers.id('claims-paused-buyer-refund'),
      );
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      await expect(escrow.connect(admin1).pauseClaims())
        .to.emit(escrow, 'ClaimsPaused')
        .withArgs(admin1.address);
      expect(await escrow.claimsPaused()).to.equal(true);

      await time.increase(7 * 24 * 3600 + 1);
      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + totalAmount);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);

      await escrow.connect(admin1).proposeUnpause(1, 0, ethers.id('claims-refund-recovery'));
      await expect(escrow.connect(admin2).approveUnpause())
        .to.emit(escrow, 'ClaimsUnpaused')
        .withArgs(admin2.address);
      expect(await escrow.claimsPaused()).to.equal(false);
    });

    it('Should restrict claim freeze controls to admins', async function () {
      await expect(escrow.connect(buyer).pauseClaims()).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );
      await escrow.connect(admin1).pauseClaims();
      await expect(
        escrow.connect(buyer).proposeUnpause(1, 0, ethers.id('unauthorized-claims-recovery')),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');
      await unpauseClaimsWithQuorum();
    });

    it('Should disable oracle in emergency and require governance recovery before unpause', async function () {
      await expect(escrow.connect(admin1).disableOracleEmergency())
        .to.emit(escrow, 'Paused')
        .withArgs(admin1.address)
        .and.to.emit(escrow, 'OracleDisabledEmergency')
        .withArgs(admin1.address, oracle.address);

      expect(await escrow.oracleActive()).to.be.false;
      expect(await escrow.paused()).to.be.true;

      await expect(
        escrow.connect(admin1).proposeUnpause(0, 0, ethers.id('test-recovery')),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOracleDisabled');

      await expect(
        escrow.connect(oracle).confirmInspectionAvailable(0, 72 * 3600),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOracleDisabled');

      const newOracle = operator1.address;
      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await escrow.connect(admin1).executeOracleUpdate(0);

      expect(await escrow.oracleAddress()).to.equal(newOracle);
      expect(await escrow.oracleActive()).to.be.true;

      await unpauseWithQuorum();
      expect(await escrow.paused()).to.be.false;
    });

    it('Should recover oracle flow end-to-end after emergency disable', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('oracle-recovery-e2e'));

      await escrow.connect(admin1).disableOracleEmergency();

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOracleDisabled');

      const newOracle = operator1.address;
      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await escrow.connect(admin1).executeOracleUpdate(0);
      await unpauseWithQuorum();

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyOracle');

      await expect(escrow.connect(operator1).releaseFundsStage1(tradeId)).to.emit(
        escrow,
        'FundsReleasedStage1',
      );
    });

    it('Should reject pause and emergency controls from non-admin callers', async function () {
      await expect(escrow.connect(buyer).pause()).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );

      await expect(escrow.connect(buyer).disableOracleEmergency()).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );

      await escrow.connect(admin1).pause();

      await expect(
        escrow.connect(buyer).proposeUnpause(0, 0, ethers.id('test-recovery')),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');

      await escrow.connect(admin1).proposeUnpause(0, 0, ethers.id('test-recovery'));

      await expect(escrow.connect(buyer).approveUnpause()).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );

      await expect(escrow.connect(buyer).cancelUnpauseProposal()).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );
    });

    it('prevents one administrator from replacing or cancelling another active recovery proposal', async function () {
      await escrow.connect(admin1).pause();
      await escrow.connect(admin1).proposeUnpause(0, 0, ethers.id('incident-primary'));

      await expect(
        escrow.connect(admin3).proposeUnpause(0, 0, ethers.id('incident-replacement')),
      ).to.be.revertedWithCustomError(escrow, 'EscrowActiveProposalExists');
      await expect(escrow.connect(admin3).cancelUnpauseProposal()).to.be.revertedWithCustomError(
        escrow,
        'EscrowActiveProposalExists',
      );

      await escrow.connect(admin2).approveUnpause();
      expect(await escrow.paused()).to.be.false;
    });
  });
}

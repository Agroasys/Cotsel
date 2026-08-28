/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerTimeoutAndTreasuryGuardTests(
  getHarness: () => AgroasysEscrowHarness,
): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let operator2!: AgroasysEscrowHarness['operator2'];
  let openDisputeAsBuyer!: AgroasysEscrowHarness['openDisputeAsBuyer'];
  let cancelLockedTradeAfterTimeoutAsBuyer!: AgroasysEscrowHarness['cancelLockedTradeAfterTimeoutAsBuyer'];
  let refundInTransitAfterTimeoutAsBuyer!: AgroasysEscrowHarness['refundInTransitAfterTimeoutAsBuyer'];
  let createDefaultTrade!: AgroasysEscrowHarness['createDefaultTrade'];
  let rotateTreasuryPayoutReceiver!: AgroasysEscrowHarness['rotateTreasuryPayoutReceiver'];

  describe('Timeout Escape Hatches', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        treasury,
        oracle,
        admin1,
        admin2,
        operator2,
        openDisputeAsBuyer,
        cancelLockedTradeAfterTimeoutAsBuyer,
        refundInTransitAfterTimeoutAsBuyer,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should allow buyer to cancel a LOCKED trade after LOCK_TIMEOUT', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id('lock-timeout'));
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId))
        .to.emit(escrow, 'TradeCancelledAfterLockTimeout')
        .withArgs(tradeId, buyer.address, totalAmount)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, totalAmount, 4, admin1.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + totalAmount);
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it('Should allow buyer to refund only remaining principal after IN_TRANSIT timeout', async function () {
      const { tradeId, supplierSecondTranche } = await createDefaultTrade(
        ethers.id('in-transit-timeout'),
      );

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId))
        .to.emit(escrow, 'InTransitTimeoutRefunded')
        .withArgs(tradeId, buyer.address, supplierSecondTranche)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, supplierSecondTranche, 5, admin1.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + supplierSecondTranche);
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it('Should prevent buyer to cancel a LOCKED trade before LOCK_TIMEOUT', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('lock-timeout'));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout - 1n);

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowLockTimeoutNotElapsed',
      );
    });

    it('Should prevent buyer to refund only remaining principal before IN_TRANSIT timeout', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('in-transit-timeout'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout - 1n);

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowInTransitTimeoutNotElapsed',
      );
    });

    it('Should prevent a second LOCK timeout cancellation', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('lock-timeout-double'));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowStatusMustBeLOCKED',
      );
    });

    it('Should prevent a second IN_TRANSIT timeout refund', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('in-transit-timeout-double'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await refundInTransitAfterTimeoutAsBuyer(tradeId);

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowStatusMustBeINTRANSIT',
      );
    });
  });

  describe('Treasury Leakage Guards', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        treasury,
        oracle,
        admin1,
        admin2,
        operator2,
        openDisputeAsBuyer,
        cancelLockedTradeAfterTimeoutAsBuyer,
        refundInTransitAfterTimeoutAsBuyer,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should refund every protected component when Stage 1 never occurs', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id('treasury-lock-timeout'));
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      expect(await escrow.nonRefundableFeeAmount(tradeId)).to.equal(0);
      expect(await escrow.buyerRefundableAmount(tradeId)).to.equal(totalAmount);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);
      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await escrow.buyerRefundableAmount(tradeId)).to.equal(0);
    });

    it('Should keep treasury at fees-only after IN_TRANSIT timeout refund', async function () {
      const { tradeId, logisticsAmount, platformFeesAmount } = await createDefaultTrade(
        ethers.id('treasury-in-transit-timeout'),
      );
      const treasuryBeforeBalance = await usdc.balanceOf(treasury.address);
      const treasuryBeforeClaimable = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      const expectedTreasuryClaimable =
        treasuryBeforeClaimable + logisticsAmount + platformFeesAmount;
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeBalance);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(expectedTreasuryClaimable);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);
      await refundInTransitAfterTimeoutAsBuyer(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeBalance);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(expectedTreasuryClaimable);
    });

    it('Should keep treasury at fees-only after dispute REFUND', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-dispute-refund'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await openDisputeAsBuyer(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });

    it('Should keep treasury at fees-only after dispute RESOLVE', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-dispute-resolve'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await openDisputeAsBuyer(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 1);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });
  });

  describe('Automatic Payout Flow', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        treasury,
        oracle,
        admin1,
        admin2,
        operator2,
        openDisputeAsBuyer,
        cancelLockedTradeAfterTimeoutAsBuyer,
        refundInTransitAfterTimeoutAsBuyer,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should pay supplier directly and keep treasury claims isolated', async function () {
      const { tradeId, supplierFirstTranche, logisticsAmount, platformFeesAmount } =
        await createDefaultTrade(ethers.id('claim-isolation'));

      const supplierBefore = await usdc.balanceOf(supplier.address);
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBefore + supplierFirstTranche,
      );
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(0);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        logisticsAmount + platformFeesAmount,
      );
      expect(await escrow.totalClaimableUsdc()).to.equal(logisticsAmount + platformFeesAmount);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        logisticsAmount + platformFeesAmount,
      );
      const treasuryClaimable = await escrow.claimableUsdc(treasury.address);
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await expect(escrow.connect(treasury).claimTreasury())
        .to.emit(escrow, 'TreasuryClaimed')
        .withArgs(treasury.address, treasury.address, treasuryClaimable, treasury.address);
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + treasuryClaimable);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);
      expect(await escrow.totalClaimableUsdc()).to.equal(0);
    });

    it('Should prevent double buyer refund transfer', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('double-claim'));
      const buyerBefore = await usdc.balanceOf(buyer.address);
      await time.increase(7 * 24 * 3600 + 1);
      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);
      const buyerAfterRefund = await usdc.balanceOf(buyer.address);

      expect(buyerAfterRefund).to.be.gt(buyerBefore);
      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowStatusMustBeLOCKED',
      );
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerAfterRefund);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
    });
  });

  describe('Treasury Sweep', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        treasury,
        oracle,
        admin1,
        admin2,
        operator2,
        openDisputeAsBuyer,
        cancelLockedTradeAfterTimeoutAsBuyer,
        refundInTransitAfterTimeoutAsBuyer,
        createDefaultTrade,
        rotateTreasuryPayoutReceiver,
      } = getHarness());
    });
    it('Should allow treasury/admin destination-locked treasury sweep', async function () {
      const { tradeId, logisticsAmount, platformFeesAmount } = await createDefaultTrade(
        ethers.id('treasury-sweep-destination-locked'),
      );
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await rotateTreasuryPayoutReceiver(operator2.address);

      const expectedTreasuryClaimable = logisticsAmount + platformFeesAmount;
      const callerBefore = await usdc.balanceOf(admin1.address);
      const receiverBefore = await usdc.balanceOf(operator2.address);
      const supplierClaimableBefore = await escrow.claimableUsdc(supplier.address);
      const buyerClaimableBefore = await escrow.claimableUsdc(buyer.address);

      await expect(escrow.connect(admin1).claimTreasury())
        .to.emit(escrow, 'TreasuryClaimed')
        .withArgs(treasury.address, operator2.address, expectedTreasuryClaimable, admin1.address);

      expect(await usdc.balanceOf(admin1.address)).to.equal(callerBefore);
      expect(await usdc.balanceOf(operator2.address)).to.equal(
        receiverBefore + expectedTreasuryClaimable,
      );
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(supplierClaimableBefore);
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(0);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(buyerClaimableBefore);
    });

    it('Should reject treasury sweep from non treasury/admin callers', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-sweep-access-control'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await expect(escrow.connect(buyer).claimTreasury()).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyTreasuryOrAdmin',
      );
    });

    it('Should reject treasury sweep when no treasury claimable exists', async function () {
      await expect(escrow.connect(treasury).claimTreasury()).to.be.revertedWithCustomError(
        escrow,
        'EscrowNothingTreasuryClaimable',
      );
    });

    it('Should allow treasury sweep during global pause when claims are not paused', async function () {
      const { tradeId, logisticsAmount, platformFeesAmount } = await createDefaultTrade(
        ethers.id('treasury-sweep-global-pause'),
      );
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(treasury).claimTreasury())
        .to.emit(escrow, 'TreasuryClaimed')
        .withArgs(
          treasury.address,
          treasury.address,
          logisticsAmount + platformFeesAmount,
          treasury.address,
        );
    });

    it('Should block treasury sweep when claims are paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-sweep-claims-paused'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await escrow.connect(admin1).pauseClaims();
      await expect(escrow.connect(treasury).claimTreasury()).to.be.revertedWithCustomError(
        escrow,
        'EscrowClaimsPaused',
      );
    });
  });
}

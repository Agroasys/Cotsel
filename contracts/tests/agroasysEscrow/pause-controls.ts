/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerPauseControlTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let operator1!: AgroasysEscrowHarness['operator1'];
  let createSignature!: AgroasysEscrowHarness['createSignature'];
  let createTradeWithAuthorizationForTest!: AgroasysEscrowHarness['createTradeWithAuthorizationForTest'];
  let openDisputeAsBuyer!: AgroasysEscrowHarness['openDisputeAsBuyer'];
  let cancelLockedTradeAfterTimeoutAsBuyer!: AgroasysEscrowHarness['cancelLockedTradeAfterTimeoutAsBuyer'];
  let refundInTransitAfterTimeoutAsBuyer!: AgroasysEscrowHarness['refundInTransitAfterTimeoutAsBuyer'];
  let finalizeAfterDisputeWindowAsSupplier!: AgroasysEscrowHarness['finalizeAfterDisputeWindowAsSupplier'];
  let createDefaultTrade!: AgroasysEscrowHarness['createDefaultTrade'];
  let unpauseWithQuorum!: AgroasysEscrowHarness['unpauseWithQuorum'];
  let unpauseTradeWithQuorum!: AgroasysEscrowHarness['unpauseTradeWithQuorum'];

  describe('Paused Matrix Hardening', function () {
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
        operator1,
        createSignature,
        createTradeWithAuthorizationForTest,
        openDisputeAsBuyer,
        cancelLockedTradeAfterTimeoutAsBuyer,
        refundInTransitAfterTimeoutAsBuyer,
        finalizeAfterDisputeWindowAsSupplier,
        createDefaultTrade,
        unpauseWithQuorum,
        unpauseTradeWithQuorum,
      } = getHarness());
    });
    it('Should block createTrade while paused', async function () {
      const totalAmount = ethers.parseUnits('106004', 6);
      const logisticsAmount = ethers.parseUnits('5000', 6);
      const platformFeesAmount = ethers.parseUnits('1504', 6);
      const supplierFirstTranche = ethers.parseUnits('59500', 6);
      const supplierSecondTranche = ethers.parseUnits('40000', 6);
      const ricardianHash = ethers.id('paused-create');
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);
      await escrow.connect(admin1).pause();

      const signature = await createSignature(
        buyer,
        await escrow.getAddress(),
        buyer.address,
        supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
      );

      await expect(
        createTradeWithAuthorizationForTest(
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          nonce,
          deadline,
          signature,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowPaused');
    });

    it('Should block release, confirm, open dispute, and finalize while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-flow'));

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowPaused');
      await unpauseWithQuorum();

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600),
      ).to.be.revertedWithCustomError(escrow, 'EscrowPaused');
      await unpauseWithQuorum();

      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      await escrow.connect(admin1).pause();
      await expect(openDisputeAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowPaused',
      );
      await unpauseWithQuorum();

      await time.increase(24 * 3600 + 1);

      await escrow.connect(admin1).pause();
      await expect(finalizeAfterDisputeWindowAsSupplier(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowPaused',
      );
    });

    it('Should block dispute propose/approve while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-dispute'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await openDisputeAsBuyer(tradeId);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(admin1).proposeDisputeSolution(tradeId, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowPaused');
      await unpauseWithQuorum();

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowPaused',
      );
    });

    it('Should allow governance recovery paths while paused', async function () {
      await escrow.connect(admin1).pause();

      await escrow.connect(admin1).proposeOracleUpdate(operator1.address);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.emit(escrow, 'OracleUpdated');

      await escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, buyer.address, 0);
      await escrow.connect(admin2).approveAdminChange(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeAdminChange(0))
        .to.emit(escrow, 'AdminAdded')
        .withArgs(buyer.address);

      await escrow.connect(admin1).proposeOracleUpdate(oracle.address);
      const governanceTtl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(governanceTtl + 1n);
      await expect(escrow.connect(admin2).cancelExpiredOracleUpdateProposal(1))
        .to.emit(escrow, 'OracleUpdateProposalExpiredCancelled')
        .withArgs(1, admin2.address);

      await expect(
        escrow.connect(admin1).proposeAdminChange(0, ethers.ZeroAddress, treasury.address, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidRoleSeparation');

      expect(await escrow.paused()).to.be.true;
    });

    it('Should block LOCK timeout cancel while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-lock-timeout'));
      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowPaused',
      );
    });

    it('Should block IN_TRANSIT timeout refund while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-in-transit-timeout'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowPaused',
      );
    });
  });

  describe('Per-Trade Pause', function () {
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
        operator1,
        createSignature,
        createTradeWithAuthorizationForTest,
        openDisputeAsBuyer,
        cancelLockedTradeAfterTimeoutAsBuyer,
        refundInTransitAfterTimeoutAsBuyer,
        finalizeAfterDisputeWindowAsSupplier,
        createDefaultTrade,
        unpauseWithQuorum,
        unpauseTradeWithQuorum,
      } = getHarness());
    });
    it('Should let admins pause and resume a single trade, emitting events', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('trade-pause-basic'));

      expect(await escrow.tradePaused(tradeId)).to.be.false;

      await expect(escrow.connect(admin1).pauseTrade(tradeId))
        .to.emit(escrow, 'TradePaused')
        .withArgs(tradeId, admin1.address);
      expect(await escrow.tradePaused(tradeId)).to.be.true;

      await escrow.connect(admin1).proposeUnpause(2, tradeId, ethers.id('trade-pause-recovery'));
      await expect(escrow.connect(admin2).approveUnpause())
        .to.emit(escrow, 'TradeUnpaused')
        .withArgs(tradeId, admin2.address);
      expect(await escrow.tradePaused(tradeId)).to.be.false;
    });

    it('Should restrict per-trade pause controls to admins', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('trade-pause-admin-only'));

      await expect(escrow.connect(buyer).pauseTrade(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );
      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(
        escrow.connect(buyer).proposeUnpause(2, tradeId, ethers.id('unauthorized-trade-recovery')),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');
      await unpauseTradeWithQuorum(tradeId);
    });

    it('Should reject pausing an unknown trade and redundant state changes', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('trade-pause-guards'));

      await expect(escrow.connect(admin1).pauseTrade(999n)).to.be.revertedWithCustomError(
        escrow,
        'EscrowTradeNotFound',
      );
      await expect(
        escrow.connect(admin1).proposeUnpause(2, tradeId, ethers.id('not-paused-trade')),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTradeNotPaused');

      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(escrow.connect(admin1).pauseTrade(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowTradeAlreadyPaused',
      );
    });

    it('Should block lifecycle transitions for a paused trade until it is resumed', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('trade-pause-flow'));

      // LOCKED → release blocked while paused, allowed after resume.
      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTradePaused');
      await unpauseTradeWithQuorum(tradeId);
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      // IN_TRANSIT → confirm inspection blocked while paused.
      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(
        escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTradePaused');
      await unpauseTradeWithQuorum(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      // ARRIVAL_CONFIRMED → buyer dispute blocked while paused.
      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(openDisputeAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowTradePaused',
      );

      // Finalization also blocked while paused.
      await time.increase(72 * 3600 + 1);
      await expect(
        escrow.connect(oracle).finalizeAfterDisputeWindow(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTradePaused');
    });

    it('Should block dispute propose and approve for a paused trade', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('trade-pause-dispute'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await openDisputeAsBuyer(tradeId);

      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(
        escrow.connect(admin1).proposeDisputeSolution(tradeId, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTradePaused');
      await unpauseTradeWithQuorum(tradeId);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await escrow.connect(admin1).pauseTrade(tradeId);
      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowTradePaused',
      );
    });

    it('Should only affect the targeted trade, leaving others live', async function () {
      await createDefaultTrade(ethers.id('trade-pause-isolation-0'));
      await createDefaultTrade(ethers.id('trade-pause-isolation-1'));
      const pausedTradeId = 0n;
      const liveTradeId = 1n;

      await escrow.connect(admin1).pauseTrade(pausedTradeId);

      await expect(
        escrow.connect(oracle).releaseFundsStage1(pausedTradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowTradePaused');

      // A different trade keeps progressing normally.
      await expect(escrow.connect(oracle).releaseFundsStage1(liveTradeId)).to.emit(
        escrow,
        'FundsReleasedStage1',
      );
    });
  });
}

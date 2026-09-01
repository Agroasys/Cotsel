/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerCreateTradeHappyPathTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let signCreateTradeAuthorization!: AgroasysEscrowHarness['signCreateTradeAuthorization'];
  let createTradeWithAuthorizationForTest!: AgroasysEscrowHarness['createTradeWithAuthorizationForTest'];

  describe('createTradeWithAuthorization', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        treasury,
        oracle,
        signCreateTradeAuthorization,
        createTradeWithAuthorizationForTest,
      } = getHarness());
    });
    const totalAmount = ethers.parseUnits('106004', 6);

    const logisticsAmount = ethers.parseUnits('5000', 6);

    const platformFeesAmount = ethers.parseUnits('1504', 6);

    const supplierFirstTranche = ethers.parseUnits('59500', 6);

    const supplierSecondTranche = ethers.parseUnits('40000', 6);

    const ricardianHash = ethers.id('trade-contract-hash');

    it('Should create a trade with valid signature', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      const signature = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
      });

      const tx = await createTradeWithAuthorizationForTest(
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
      );

      await expect(tx)
        .to.emit(escrow, 'TradeLocked')
        .withArgs(
          0,
          buyer.address,
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
        );

      const trade = await escrow.trades(0);
      expect(trade.tradeId).to.equal(0);
      expect(trade.status).to.equal(0); // LOCKED
      expect(trade.buyerAddress).to.equal(buyer.address);
      expect(trade.supplierAddress).to.equal(supplier.address);
      expect(trade.totalAmountLocked).to.equal(totalAmount);
      expect(await escrow.authorizationNonces(buyer.address)).to.equal(nonce + 1n);
    });

    it('Should preserve the launch 60/40 and fee accounting invariant on-chain', async function () {
      const goodsAmount = ethers.parseUnits('1000', 6);
      const buyerPlatformFee = ethers.parseUnits('10', 6);
      const settlementSupportFee = ethers.parseUnits('4', 6);
      const supplierPlatformFee = ethers.parseUnits('5', 6);
      const orderLogisticsFee = ethers.parseUnits('50', 6);
      const firstSupplierNet = ethers.parseUnits('595', 6);
      const finalSupplierTranche = ethers.parseUnits('400', 6);
      const combinedPlatformFees = buyerPlatformFee + settlementSupportFee + supplierPlatformFee;
      const buyerCharge = goodsAmount + orderLogisticsFee + buyerPlatformFee + settlementSupportFee;

      await createTradeWithAuthorizationForTest(
        supplier.address,
        buyerCharge,
        orderLogisticsFee,
        combinedPlatformFees,
        firstSupplierNet,
        finalSupplierTranche,
        ethers.id('launch-accounting-invariant'),
      );

      const trade = await escrow.trades(0);
      expect(trade.totalAmountLocked).to.equal(buyerCharge);
      expect(trade.supplierFirstTranche).to.equal(firstSupplierNet);
      expect(trade.supplierSecondTranche).to.equal(finalSupplierTranche);
      expect(await escrow.nonRefundableFeeAmount(0)).to.equal(0);

      const supplierBefore = await usdc.balanceOf(supplier.address);
      await escrow.connect(oracle).releaseFundsStage1(0);

      expect(await usdc.balanceOf(supplier.address)).to.equal(supplierBefore + firstSupplierNet);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        orderLogisticsFee + combinedPlatformFees,
      );
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(
        finalSupplierTranche + orderLogisticsFee + combinedPlatformFees,
      );
    });

    it('Should reject non-launch tranche or fee proportions on the strict entry point', async function () {
      await expect(
        createTradeWithAuthorizationForTest(
          supplier.address,
          ethers.parseUnits('1064', 6),
          ethers.parseUnits('50', 6),
          ethers.parseUnits('19', 6),
          ethers.parseUnits('400', 6),
          ethers.parseUnits('595', 6),
          ethers.id('invalid-launch-accounting'),
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidLaunchSettlementSchedule');
    });

    it('Should create multiple trades with incrementing nonces', async function () {
      const amount = ethers.parseUnits('106004', 6);
      const hash1 = ethers.id('hash1');
      const hash2 = ethers.id('hash2');

      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      const nonce0 = await escrow.authorizationNonces(buyer.address);

      // First trade with nonce 0
      const sig1 = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount: amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash: hash1,
        nonce: nonce0,
        deadline,
      });

      await createTradeWithAuthorizationForTest(
        supplier.address,
        amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        hash1,
        nonce0,
        deadline,
        sig1,
      );

      const nonce1 = await escrow.authorizationNonces(buyer.address);
      // Second trade with nonce 1
      const sig2 = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount: amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash: hash2,
        nonce: nonce1,
        deadline,
      });

      await createTradeWithAuthorizationForTest(
        supplier.address,
        amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        hash2,
        nonce1,
        deadline,
        sig2,
      );

      expect(await escrow.tradeCounter()).to.equal(2);
      expect(await escrow.authorizationNonces(buyer.address)).to.equal(2);
    });

    it('Should hold and progress 64 independent escrows for one buyer and supplier', async function () {
      this.timeout(120_000);

      const tradeCount = 64n;
      const launchSupportFee = ethers.parseUnits('4', 6);
      const schedules = Array.from({ length: Number(tradeCount) }, (_, index) => {
        const goodsAmount =
          ethers.parseUnits('100000', 6) + ethers.parseUnits('1000', 6) * BigInt(index);
        const tradeLogisticsAmount = logisticsAmount + ethers.parseUnits('10', 6) * BigInt(index);
        const buyerFee = (goodsAmount * 100n) / 10_000n;
        const supplierFee = (goodsAmount * 50n) / 10_000n;
        const firstTrancheGross = (goodsAmount * 6_000n) / 10_000n;
        const tradePlatformFeesAmount = buyerFee + supplierFee + launchSupportFee;
        const tradeSupplierFirstTranche = firstTrancheGross - supplierFee;
        const tradeSupplierSecondTranche = goodsAmount - firstTrancheGross;
        const tradeTotalAmount =
          tradeLogisticsAmount +
          tradePlatformFeesAmount +
          tradeSupplierFirstTranche +
          tradeSupplierSecondTranche;

        return {
          tradeId: BigInt(index),
          tradeTotalAmount,
          tradeLogisticsAmount,
          tradePlatformFeesAmount,
          tradeSupplierFirstTranche,
          tradeSupplierSecondTranche,
          ricardianHash: ethers.id(`capacity-trade-${index}`),
        };
      });
      const totalLocked = schedules.reduce((sum, schedule) => sum + schedule.tradeTotalAmount, 0n);
      const supplierStage1Total = schedules.reduce(
        (sum, schedule) => sum + schedule.tradeSupplierFirstTranche,
        0n,
      );
      const treasuryTotal = schedules.reduce(
        (sum, schedule) => sum + schedule.tradeLogisticsAmount + schedule.tradePlatformFeesAmount,
        0n,
      );
      const supplierStage2Total = schedules.reduce(
        (sum, schedule) => sum + schedule.tradeSupplierSecondTranche,
        0n,
      );
      await usdc.mint(buyer.address, totalLocked);

      for (const schedule of schedules) {
        await createTradeWithAuthorizationForTest(
          supplier.address,
          schedule.tradeTotalAmount,
          schedule.tradeLogisticsAmount,
          schedule.tradePlatformFeesAmount,
          schedule.tradeSupplierFirstTranche,
          schedule.tradeSupplierSecondTranche,
          schedule.ricardianHash,
        );

        const trade = await escrow.trades(schedule.tradeId);
        expect(trade.tradeId).to.equal(schedule.tradeId);
        expect(trade.buyerAddress).to.equal(buyer.address);
        expect(trade.supplierAddress).to.equal(supplier.address);
        expect(trade.totalAmountLocked).to.equal(schedule.tradeTotalAmount);
        expect(trade.logisticsAmount).to.equal(schedule.tradeLogisticsAmount);
        expect(trade.platformFeesAmount).to.equal(schedule.tradePlatformFeesAmount);
        expect(trade.supplierFirstTranche).to.equal(schedule.tradeSupplierFirstTranche);
        expect(trade.supplierSecondTranche).to.equal(schedule.tradeSupplierSecondTranche);
        expect(trade.ricardianHash).to.equal(schedule.ricardianHash);
      }

      expect(await escrow.tradeCounter()).to.equal(tradeCount);
      expect(await escrow.authorizationNonces(buyer.address)).to.equal(tradeCount);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(totalLocked);

      const supplierBefore = await usdc.balanceOf(supplier.address);
      for (const schedule of schedules) {
        await escrow.connect(oracle).releaseFundsStage1(schedule.tradeId);
        expect((await escrow.trades(schedule.tradeId)).status).to.equal(1);
      }

      expect(await usdc.balanceOf(supplier.address)).to.equal(supplierBefore + supplierStage1Total);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryTotal);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(
        supplierStage2Total + treasuryTotal,
      );
    });
  });
}

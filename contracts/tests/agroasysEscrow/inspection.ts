/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerInspectionTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let signUserActionAuthorization!: AgroasysEscrowHarness['signUserActionAuthorization'];
  let createTradeWithAuthorizationForTest!: AgroasysEscrowHarness['createTradeWithAuthorizationForTest'];
  let finalizeAfterInspectionAcceptanceAsBuyer!: AgroasysEscrowHarness['finalizeAfterInspectionAcceptanceAsBuyer'];

  describe('confirmInspectionAvailable', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        oracle,
        admin1,
        signUserActionAuthorization,
        createTradeWithAuthorizationForTest,
        finalizeAfterInspectionAcceptanceAsBuyer,
      } = getHarness());
    });
    let tradeId: bigint;

    beforeEach(async function () {
      const totalAmount = ethers.parseUnits('106004', 6);
      const ricardianHash = ethers.id('trade-hash');

      await createTradeWithAuthorizationForTest(
        supplier.address,
        totalAmount,
        ethers.parseUnits('5000', 6),
        ethers.parseUnits('1504', 6),
        ethers.parseUnits('59500', 6),
        ethers.parseUnits('40000', 6),
        ricardianHash,
      );

      tradeId = 0n;
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
    });

    it('Should confirm inspection availability with the standard 72-hour window', async function () {
      await expect(escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600)).to.emit(
        escrow,
        'InspectionAvailable',
      );

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(2); // ARRIVAL_CONFIRMED
      expect(trade.arrivalTimestamp).to.be.gt(0);
      expect(await escrow.inspectionWindowSeconds(tradeId)).to.equal(72 * 3600);
      expect(await escrow.inspectionDeadline(tradeId)).to.equal(
        trade.arrivalTimestamp + 72n * 3600n,
      );
    });

    it('Should support an explicitly selected 48-hour packaged-local window', async function () {
      await expect(escrow.connect(oracle).confirmInspectionAvailable(tradeId, 48 * 3600)).to.emit(
        escrow,
        'InspectionAvailable',
      );

      const trade = await escrow.trades(tradeId);
      expect(await escrow.inspectionWindowSeconds(tradeId)).to.equal(48 * 3600);
      expect(await escrow.inspectionDeadline(tradeId)).to.equal(
        trade.arrivalTimestamp + 48n * 3600n,
      );
    });

    it('Should reject arbitrary inspection windows', async function () {
      await expect(
        escrow.connect(oracle).confirmInspectionAvailable(tradeId, 12 * 3600),
      ).to.be.revertedWithCustomError(escrow, 'EscrowUnsupportedInspectionWindow');
    });

    it('Should release the final tranche immediately after inspection acceptance', async function () {
      const supplierBefore = await usdc.balanceOf(supplier.address);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      await expect(finalizeAfterInspectionAcceptanceAsBuyer(tradeId))
        .to.emit(escrow, 'InspectionAcceptedForFinalRelease')
        .and.to.emit(escrow, 'FinalTrancheReleased');

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4);
      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBefore + trade.supplierSecondTranche,
      );
    });

    it('rejects Oracle bypass and invalid buyer inspection authorizations', async function () {
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      const legacyCall = new ethers.Interface([
        'function finalizeAfterInspectionAcceptance(uint256 tradeId)',
      ]).encodeFunctionData('finalizeAfterInspectionAcceptance', [tradeId]);
      await expect(oracle.sendTransaction({ to: await escrow.getAddress(), data: legacyCall })).to
        .be.reverted;

      const nonce = await escrow.authorizationNonces(buyer.address);
      const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
      const deadline = now + 3600n;
      const wrongSigner = await signUserActionAuthorization(supplier, {
        user: buyer.address,
        action: 5,
        tradeId,
        nonce,
        deadline,
      });

      await expect(
        escrow
          .connect(admin1)
          .finalizeAfterInspectionAcceptanceWithAuthorization(
            tradeId,
            nonce,
            deadline,
            wrongSigner,
          ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');

      const expired = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 5,
        tradeId,
        nonce,
        deadline: now - 1n,
      });
      await expect(
        escrow
          .connect(admin1)
          .finalizeAfterInspectionAcceptanceWithAuthorization(tradeId, nonce, now - 1n, expired),
      ).to.be.revertedWithCustomError(escrow, 'EscrowAuthorizationExpired');

      const wrongDomain = await signUserActionAuthorization(
        buyer,
        { user: buyer.address, action: 5, tradeId, nonce, deadline },
        { chainId: 84532n },
      );
      await expect(
        escrow
          .connect(admin1)
          .finalizeAfterInspectionAcceptanceWithAuthorization(
            tradeId,
            nonce,
            deadline,
            wrongDomain,
          ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');

      const valid = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 5,
        tradeId,
        nonce,
        deadline,
      });
      await escrow
        .connect(admin1)
        .finalizeAfterInspectionAcceptanceWithAuthorization(tradeId, nonce, deadline, valid);

      await expect(
        escrow
          .connect(admin1)
          .finalizeAfterInspectionAcceptanceWithAuthorization(tradeId, nonce, deadline, valid),
      ).to.be.reverted;
    });

    it('Should let the active oracle release the final tranche after the notice deadline', async function () {
      const supplierBefore = await usdc.balanceOf(supplier.address);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await time.increase(72 * 3600 + 1);

      await expect(escrow.connect(oracle).finalizeAfterDisputeWindow(tradeId)).to.emit(
        escrow,
        'FinalTrancheReleased',
      );

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4);
      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBefore + trade.supplierSecondTranche,
      );
    });

    it('Should reject deadline finalization from an unrelated account', async function () {
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
      await time.increase(72 * 3600 + 1);

      await expect(
        escrow.connect(buyer).finalizeAfterDisputeWindow(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyOracleOrAdmin');
    });

    it('Should reject if not oracle', async function () {
      await expect(
        escrow.connect(buyer).confirmInspectionAvailable(tradeId, 72 * 3600),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyOracle');
    });

    it('Should reject if wrong status', async function () {
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      await expect(
        escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600),
      ).to.be.revertedWithCustomError(escrow, 'EscrowStatusMustBeINTRANSIT');
    });
  });
}

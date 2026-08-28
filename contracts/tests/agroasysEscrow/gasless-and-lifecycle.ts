/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerGaslessAndLifecycleTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let operator2!: AgroasysEscrowHarness['operator2'];
  let signCreateTradeAuthorization!: AgroasysEscrowHarness['signCreateTradeAuthorization'];
  let signUserActionAuthorization!: AgroasysEscrowHarness['signUserActionAuthorization'];
  let signUsdcReceiveAuthorization!: AgroasysEscrowHarness['signUsdcReceiveAuthorization'];
  let createTradeWithAuthorizationForTest!: AgroasysEscrowHarness['createTradeWithAuthorizationForTest'];
  let finalizeAfterDisputeWindowAsSupplier!: AgroasysEscrowHarness['finalizeAfterDisputeWindowAsSupplier'];

  describe('Gasless typed authorizations', function () {
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
        signCreateTradeAuthorization,
        signUserActionAuthorization,
        signUsdcReceiveAuthorization,
        createTradeWithAuthorizationForTest,
        finalizeAfterDisputeWindowAsSupplier,
      } = getHarness());
    });
    const totalAmount = ethers.parseUnits('106004', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('1504', 6);
    const supplierFirstTranche = ethers.parseUnits('59500', 6);
    const supplierSecondTranche = ethers.parseUnits('40000', 6);

    async function prepareGaslessTrade(ricardianHash = ethers.id('gasless-trade')) {
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const authDeadline = BigInt(blockTimestamp + 3600);
      const authNonce = await escrow.getAuthorizationNonce(buyer.address);
      const tokenNonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0n;
      const validBefore = BigInt(blockTimestamp + 3600);

      const authorizationSignature = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce: authNonce,
        deadline: authDeadline,
      });
      const usdcAuthorization = await signUsdcReceiveAuthorization(buyer, {
        from: buyer.address,
        to: await escrow.getAddress(),
        value: totalAmount,
        validAfter,
        validBefore,
        nonce: tokenNonce,
      });

      return {
        ricardianHash,
        authNonce,
        authDeadline,
        tokenNonce,
        usdcAuthorization: {
          validAfter,
          validBefore,
          nonce: tokenNonce,
          v: usdcAuthorization.v,
          r: usdcAuthorization.r,
          s: usdcAuthorization.s,
        },
        authorizationSignature,
      };
    }

    async function submitPreparedGaslessTrade(
      prepared: Awaited<ReturnType<typeof prepareGaslessTrade>>,
    ) {
      return escrow
        .connect(admin1)
        .createTradeWithAuthorization(
          buyer.address,
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          prepared.ricardianHash,
          prepared.authNonce,
          prepared.authDeadline,
          prepared.authorizationSignature,
          prepared.usdcAuthorization,
        );
    }

    async function createGaslessTrade(ricardianHash = ethers.id('gasless-trade')) {
      const prepared = await prepareGaslessTrade(ricardianHash);
      const tx = await submitPreparedGaslessTrade(prepared);
      return { tx, tradeId: 0n, prepared };
    }

    it('creates and funds a trade through relayed EIP-712 and USDC authorization', async function () {
      const escrowBefore = await usdc.balanceOf(await escrow.getAddress());
      const buyerBefore = await usdc.balanceOf(buyer.address);
      const { tx, prepared } = await createGaslessTrade(ethers.id('gasless-create'));

      await expect(tx)
        .to.emit(escrow, 'AuthorizationConsumed')
        .withArgs(
          buyer.address,
          ethers.id('CREATE_TRADE'),
          0n,
          admin1.address,
          prepared.authDeadline,
        );
      await expect(tx)
        .to.emit(escrow, 'GaslessTradeFunded')
        .withArgs(0n, buyer.address, prepared.tokenNonce, totalAmount);
      await expect(tx)
        .to.emit(escrow, 'RelayedActionExecuted')
        .withArgs(admin1.address, buyer.address, ethers.id('CREATE_TRADE'), 0n);

      const trade = await escrow.trades(0);
      expect(trade.buyerAddress).to.equal(buyer.address);
      expect(trade.supplierAddress).to.equal(supplier.address);
      expect(trade.totalAmountLocked).to.equal(totalAmount);
      expect(await escrow.getAuthorizationNonce(buyer.address)).to.equal(1n);
      expect(await usdc.authorizationState(buyer.address, prepared.tokenNonce)).to.equal(true);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(escrowBefore + totalAmount);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBefore - totalAmount);
    });

    it('rejects replayed gasless create-trade authorizations', async function () {
      const prepared = await prepareGaslessTrade(ethers.id('gasless-replay'));
      await submitPreparedGaslessTrade(prepared);

      await expect(submitPreparedGaslessTrade(prepared)).to.be.revertedWithCustomError(
        escrow,
        'EscrowBadAuthorizationNonce',
      );
    });

    it('rejects tampered gasless trade amounts before consuming USDC authorization', async function () {
      const prepared = await prepareGaslessTrade(ethers.id('gasless-tamper'));
      await expect(
        escrow
          .connect(admin1)
          .createTradeWithAuthorization(
            buyer.address,
            supplier.address,
            totalAmount + 1n,
            logisticsAmount,
            platformFeesAmount,
            supplierFirstTranche,
            supplierSecondTranche,
            prepared.ricardianHash,
            prepared.authNonce,
            prepared.authDeadline,
            prepared.authorizationSignature,
            prepared.usdcAuthorization,
          ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBreakdownMismatch');

      expect(await usdc.authorizationState(buyer.address, prepared.tokenNonce)).to.equal(false);
    });

    it('executes buyer actions only through admins or allowlisted relayers', async function () {
      const { tradeId } = await createGaslessTrade(ethers.id('gasless-action'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 48 * 3600);
      const nonce = await escrow.getAuthorizationNonce(buyer.address);
      const signature = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 1,
        tradeId,
        nonce,
        deadline,
      });

      await expect(
        escrow.connect(buyer).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyRelayerOrAdmin');

      await escrow.connect(admin1).proposeAdminChange(4, ethers.ZeroAddress, operator2.address, 0);
      await escrow.connect(admin2).approveAdminChange(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeAdminChange(0))
        .to.emit(escrow, 'RelayerUpdated')
        .withArgs(operator2.address, true, admin1.address);

      await expect(
        escrow.connect(operator2).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      )
        .to.emit(escrow, 'RelayedActionExecuted')
        .withArgs(operator2.address, buyer.address, ethers.id('OPEN_DISPUTE'), tradeId);

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(3);
    });
  });

  describe('Complete Flow (Without dispute)', function () {
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
        signCreateTradeAuthorization,
        signUserActionAuthorization,
        signUsdcReceiveAuthorization,
        createTradeWithAuthorizationForTest,
        finalizeAfterDisputeWindowAsSupplier,
      } = getHarness());
    });
    let tradeId: bigint;
    const totalAmount = ethers.parseUnits('106004', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('1504', 6);
    const supplierFirstTranche = ethers.parseUnits('59500', 6);
    const supplierSecondTranche = ethers.parseUnits('40000', 6);

    beforeEach(async function () {
      const ricardianHash = ethers.id('trade-hash');

      await createTradeWithAuthorizationForTest(
        supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
      );

      tradeId = 0n;
    });

    it('Should complete full trade lifecycle without dispute', async function () {
      const supplierBalBefore = await usdc.balanceOf(supplier.address);
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      const stage1Tx = await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await expect(stage1Tx).to.emit(escrow, 'FundsReleasedStage1');
      await expect(stage1Tx).to.emit(escrow, 'PlatformFeesPaidStage1');
      await expect(stage1Tx)
        .to.emit(escrow, 'SupplierPayoutTransferred')
        .withArgs(tradeId, supplier.address, supplierFirstTranche, 0, oracle.address);
      await expect(stage1Tx)
        .to.emit(escrow, 'ClaimableAccrued')
        .withArgs(tradeId, treasury.address, logisticsAmount, 1);
      await expect(stage1Tx)
        .to.emit(escrow, 'ClaimableAccrued')
        .withArgs(tradeId, treasury.address, platformFeesAmount, 2);

      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBalBefore + supplierFirstTranche,
      );
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBalBefore);
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(0);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        logisticsAmount + platformFeesAmount,
      );

      let trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(1); // IN_TRANSIT

      await expect(escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600)).to.emit(
        escrow,
        'InspectionAvailable',
      );

      trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(2); // ARRIVAL_CONFIRMED

      await time.increase(72 * 3600 + 1);

      const supplierBalBeforeStage2 = await usdc.balanceOf(supplier.address);

      await expect(finalizeAfterDisputeWindowAsSupplier(tradeId)).to.emit(
        escrow,
        'FinalTrancheReleased',
      );

      expect(await escrow.claimableUsdc(supplier.address)).to.equal(0);

      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBalBeforeStage2 + supplierSecondTranche,
      );

      trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });
  });

  describe('releaseFundsStage1', function () {
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
        signCreateTradeAuthorization,
        signUserActionAuthorization,
        signUsdcReceiveAuthorization,
        createTradeWithAuthorizationForTest,
        finalizeAfterDisputeWindowAsSupplier,
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
    });

    it('Should reject if not oracle', async function () {
      await expect(escrow.connect(buyer).releaseFundsStage1(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyOracle',
      );
    });

    it('Should reject if wrong status', async function () {
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId),
      ).to.be.revertedWithCustomError(escrow, 'EscrowStatusMustBeLOCKED');
    });
  });
}

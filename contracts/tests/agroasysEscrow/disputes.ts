/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerDisputeTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let relayer!: AgroasysEscrowHarness['relayer'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let signUserActionAuthorization!: AgroasysEscrowHarness['signUserActionAuthorization'];
  let createTradeWithAuthorizationForTest!: AgroasysEscrowHarness['createTradeWithAuthorizationForTest'];
  let openDisputeAsBuyer!: AgroasysEscrowHarness['openDisputeAsBuyer'];

  describe('Dispute Flow', function () {
    beforeEach(function () {
      ({
        escrow,
        usdc,
        buyer,
        supplier,
        oracle,
        relayer,
        admin1,
        admin2,
        signUserActionAuthorization,
        createTradeWithAuthorizationForTest,
        openDisputeAsBuyer,
      } = getHarness());
    });
    let tradeId: bigint;
    const supplierSecondTranche = ethers.parseUnits('40000', 6);
    const supplierFirstTranche = ethers.parseUnits('59500', 6);
    const logistics = ethers.parseUnits('5000', 6);
    const fees = ethers.parseUnits('1504', 6);
    const totalAmount = ethers.parseUnits('106004', 6);

    beforeEach(async function () {
      const ricardianHash = ethers.id('trade-hash');

      await createTradeWithAuthorizationForTest(
        supplier.address,
        totalAmount,
        logistics,
        fees,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
      );

      tradeId = 0n;
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);
    });

    it('Should allow buyer to open a dispute during the 72-hour notice window', async function () {
      await expect(openDisputeAsBuyer(tradeId)).to.emit(escrow, 'DisputeOpenedByBuyer');

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(3); // FROZEN
    });

    it('Should reject a dispute after the 72-hour notice window', async function () {
      await time.increase(72 * 3600 + 1);

      await expect(openDisputeAsBuyer(tradeId)).to.be.revertedWithCustomError(
        escrow,
        'EscrowWindowClosed',
      );
    });

    it('Should reject dispute authorization from non-buyer', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const signature = await signUserActionAuthorization(supplier, {
        user: buyer.address,
        action: 1,
        tradeId,
        nonce,
        deadline,
      });

      await expect(
        escrow.connect(admin1).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');
    });

    it('rejects user-action signatures from the wrong EIP-712 chain domain', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const signature = await signUserActionAuthorization(
        buyer,
        {
          user: buyer.address,
          action: 1,
          tradeId,
          nonce,
          deadline,
        },
        { chainId: chainId + 1n },
      );

      await expect(
        escrow.connect(admin1).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');
    });

    it('rejects user-action signatures from the wrong EIP-712 verifying contract domain', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const signature = await signUserActionAuthorization(
        buyer,
        {
          user: buyer.address,
          action: 1,
          tradeId,
          nonce,
          deadline,
        },
        { verifyingContract: relayer.address },
      );

      await expect(
        escrow.connect(admin1).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');
    });

    it('Should refund buyer after dispute REFUND resolution', async function () {
      await openDisputeAsBuyer(tradeId);

      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      // propose REFUND
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0); // REFUND

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, 'DisputePayout')
        .withArgs(tradeId, 0, buyer.address, supplierSecondTranche, 0)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, supplierSecondTranche, 6, admin2.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + supplierSecondTranche);

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it('Should pay supplier after dispute RESOLVE resolution', async function () {
      await openDisputeAsBuyer(tradeId);

      const supplierBalBefore = await usdc.balanceOf(supplier.address);

      // propose RESOLVE
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 1); // RESOLVE

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, 'DisputePayout')
        .withArgs(tradeId, 0, supplier.address, supplierSecondTranche, 1);

      expect(await escrow.claimableUsdc(supplier.address)).to.equal(0);
      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBalBefore + supplierSecondTranche,
      );

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it('Should reject dispute proposal from non-admin', async function () {
      await openDisputeAsBuyer(tradeId);

      await expect(
        escrow.connect(buyer).proposeDisputeSolution(tradeId, 0),
      ).to.be.revertedWithCustomError(escrow, 'EscrowOnlyAdmin');
    });

    it('Should reject dispute approval from non-admin', async function () {
      await openDisputeAsBuyer(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await expect(escrow.connect(buyer).approveDisputeSolution(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowOnlyAdmin',
      );
    });

    it('Should enforce dispute proposal expiry and allow manual cancellation', async function () {
      await openDisputeAsBuyer(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWithCustomError(
        escrow,
        'EscrowProposalExpired',
      );

      await expect(escrow.connect(admin2).cancelExpiredDisputeProposal(0))
        .to.emit(escrow, 'DisputeProposalExpiredCancelled')
        .withArgs(0, tradeId, admin2.address);

      await expect(escrow.connect(admin2).proposeDisputeSolution(tradeId, 1))
        .to.emit(escrow, 'DisputeSolutionProposed')
        .withArgs(1, tradeId, 1, admin2.address);
    });

    it('Should auto-cancel expired active proposal when replacing with a new one', async function () {
      await openDisputeAsBuyer(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin2).proposeDisputeSolution(tradeId, 1))
        .to.emit(escrow, 'DisputeProposalExpiredCancelled')
        .withArgs(0, tradeId, admin2.address)
        .and.to.emit(escrow, 'DisputeSolutionProposed')
        .withArgs(1, tradeId, 1, admin2.address);
    });
  });
}

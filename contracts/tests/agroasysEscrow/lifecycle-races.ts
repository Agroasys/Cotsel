/** SPDX-License-Identifier: Apache-2.0 */
import { expect } from 'chai';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerLifecycleRaceTests(getHarness: () => AgroasysEscrowHarness): void {
  describe('buyer approval versus governed Oracle deadline release', () => {
    for (const winner of ['buyer', 'oracle'] as const) {
      it(`settles once when ${winner} executes first and records the actual buyer nonce outcome`, async () => {
        const h = getHarness();
        const trade = await h.createDefaultTrade();
        await h.escrow.connect(h.oracle).releaseFundsStage1(trade.tradeId);
        await h.escrow.connect(h.oracle).confirmInspectionAvailable(trade.tradeId, 72 * 3600);
        const inspectionDeadline = await h.escrow.inspectionDeadline(trade.tradeId);
        await time.increaseTo(inspectionDeadline - 30n);
        const nonce = await h.escrow.authorizationNonces(h.buyer.address);
        const deadline = inspectionDeadline + 600n;
        const signature = await h.signUserActionAuthorization(h.buyer, {
          user: h.buyer.address,
          action: 5,
          tradeId: trade.tradeId,
          nonce,
          deadline,
        });
        const buyer = () =>
          h.escrow
            .connect(h.relayer)
            .finalizeAfterInspectionAcceptanceWithAuthorization(
              trade.tradeId,
              nonce,
              deadline,
              signature,
            );
        const oracle = () => h.escrow.connect(h.oracle).finalizeAfterDisputeWindow(trade.tradeId);
        const before = await h.usdc.balanceOf(h.supplier.address);
        await time.increaseTo(inspectionDeadline + 1n);
        await expect(winner === 'buyer' ? buyer() : oracle()).to.emit(
          h.escrow,
          'FinalTrancheReleased',
        );
        await expect(winner === 'buyer' ? oracle() : buyer()).to.be.revertedWithCustomError(
          h.escrow,
          'EscrowMustBeARRIVALCONFIRMED',
        );
        expect(await h.usdc.balanceOf(h.supplier.address)).to.equal(
          before + trade.supplierSecondTranche,
        );
        expect((await h.escrow.trades(trade.tradeId)).status).to.equal(4);
        expect(await h.escrow.authorizationNonces(h.buyer.address)).to.equal(
          winner === 'buyer' ? nonce + 1n : nonce,
        );
      });
    }
  });
}

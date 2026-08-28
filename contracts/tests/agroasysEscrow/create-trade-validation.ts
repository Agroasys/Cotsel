/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerCreateTradeValidationTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let buyer!: AgroasysEscrowHarness['buyer'];
  let supplier!: AgroasysEscrowHarness['supplier'];
  let relayer!: AgroasysEscrowHarness['relayer'];
  let createSignature!: AgroasysEscrowHarness['createSignature'];
  let signCreateTradeAuthorization!: AgroasysEscrowHarness['signCreateTradeAuthorization'];
  let createTradeWithAuthorizationForTest!: AgroasysEscrowHarness['createTradeWithAuthorizationForTest'];

  describe('createTradeWithAuthorization', function () {
    beforeEach(function () {
      ({
        escrow,
        buyer,
        supplier,
        relayer,
        createSignature,
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

    it('Should reject invalid signature (wrong signer)', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      // Signature from wrong signer
      const signature = await createSignature(
        supplier, // wrong signer
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
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');
    });

    it('Should reject replay signature', async function () {
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

      // try to create a trade with the same signature
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
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorizationNonce'); // got rejected because of the nonce
    });

    it('Should reject with invalid parameters (zero addresses, bad hash, mismatched amounts)', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await expect(
        createTradeWithAuthorizationForTest(
          ethers.ZeroAddress,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          nonce,
          deadline,
          '0x00',
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowSupplierRequired');

      await expect(
        createTradeWithAuthorizationForTest(
          await escrow.getAddress(),
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          nonce,
          deadline,
          '0x00',
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowSupplierCannotBeEscrow');

      await expect(
        createTradeWithAuthorizationForTest(
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ethers.ZeroHash,
          nonce,
          deadline,
          '0x00',
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowRicardianHashRequired');

      const wrongTotal = ethers.parseUnits('100000', 6);
      await expect(
        createTradeWithAuthorizationForTest(
          supplier.address,
          wrongTotal,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          nonce,
          deadline,
          '0x00',
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBreakdownMismatch');
    });

    it('Should reject with bad nonce', async function () {
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const wrongNonce = 5n;

      const signature = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce: wrongNonce,
        deadline,
      });

      await expect(
        createTradeWithAuthorizationForTest(
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          wrongNonce,
          deadline,
          signature,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorizationNonce');
    });

    it('Should reject expired signature', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const expiredDeadline = BigInt(blockTimestamp - 100);

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
        deadline: expiredDeadline,
      });

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
          expiredDeadline,
          signature,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowAuthorizationExpired');
    });

    it('rejects create-trade signatures from the wrong EIP-712 chain domain', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const signature = await signCreateTradeAuthorization(
        buyer,
        {
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
        },
        { chainId: chainId + 1n },
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
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');
    });

    it('rejects create-trade signatures from the wrong EIP-712 verifying contract domain', async function () {
      const nonce = await escrow.authorizationNonces(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      const signature = await signCreateTradeAuthorization(
        buyer,
        {
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
        },
        { verifyingContract: relayer.address },
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
      ).to.be.revertedWithCustomError(escrow, 'EscrowBadAuthorization');
    });
  });
}

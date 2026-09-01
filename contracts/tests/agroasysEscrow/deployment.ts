/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { artifacts, ethers } from 'hardhat';
import type { AgroasysEscrowHarness } from '../AgroasysEscrow';

export function registerDeploymentTests(getHarness: () => AgroasysEscrowHarness): void {
  let escrow!: AgroasysEscrowHarness['escrow'];
  let usdc!: AgroasysEscrowHarness['usdc'];
  let treasury!: AgroasysEscrowHarness['treasury'];
  let oracle!: AgroasysEscrowHarness['oracle'];
  let relayer!: AgroasysEscrowHarness['relayer'];
  let admin1!: AgroasysEscrowHarness['admin1'];
  let admin2!: AgroasysEscrowHarness['admin2'];
  let admin3!: AgroasysEscrowHarness['admin3'];

  describe('Deployment', function () {
    beforeEach(function () {
      ({ escrow, usdc, treasury, oracle, relayer, admin1, admin2, admin3 } = getHarness());
    });
    it('Keeps deployed bytecode within the EVM contract-size limit @skip-on-coverage', async function () {
      const artifact = await artifacts.readArtifact('AgroasysEscrow');
      const deployedBytecodeBytes = (artifact.deployedBytecode.length - 2) / 2;

      expect(deployedBytecodeBytes).to.be.at.most(24_576);
      expect(deployedBytecodeBytes).to.be.at.most(24_000);
    });

    it('Should set correct initial values', async function () {
      expect(await escrow.oracleAddress()).to.equal(oracle.address);
      expect(await escrow.treasuryAddress()).to.equal(treasury.address);
      expect(await escrow.treasuryPayoutAddress()).to.equal(treasury.address);
      expect(await escrow.requiredApprovals()).to.equal(2);
      expect(await escrow.governanceTimelock()).to.equal(24 * 3600);
      expect(await escrow.oracleActive()).to.be.true;
      expect(await escrow.paused()).to.be.false;
      expect(await escrow.claimsPaused()).to.be.false;
      expect(await escrow.isRelayer(relayer.address)).to.be.true;
      expect(await escrow.isAdmin(admin1.address)).to.be.true;
      expect(await escrow.isAdmin(admin2.address)).to.be.true;
      expect(await escrow.isAdmin(admin3.address)).to.be.true;
    });

    it('Should reject invalid constructor params', async function () {
      const EscrowFactory = await ethers.getContractFactory('AgroasysEscrow');

      await expect(
        EscrowFactory.deploy(
          ethers.ZeroAddress,
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidToken');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          treasury.address,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidOracle');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          ethers.ZeroAddress,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidTreasury');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          ethers.ZeroAddress,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowInvalidRelayer');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address],
          0,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowRequiredApprovalsMustBeAtLeast2');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowRequiredApprovalsMustBeAtLeast2');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address, admin2.address],
          3,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowNotEnoughAdmins');
    });

    it('Should reject an admin set at parity with the approval threshold', async function () {
      const EscrowFactory = await ethers.getContractFactory('AgroasysEscrow');

      // admins == requiredApprovals leaves no spare signer: losing one key would
      // permanently disable dispute resolution, unpause and governance rotation.
      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address, admin2.address],
          2,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowNotEnoughAdmins');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address, admin2.address, admin3.address],
          3,
        ),
      ).to.be.revertedWithCustomError(escrow, 'EscrowNotEnoughAdmins');
    });

    it('Should accept an admin set with at least one spare signer', async function () {
      const EscrowFactory = await ethers.getContractFactory('AgroasysEscrow');

      const spareEscrow = await EscrowFactory.deploy(
        await usdc.getAddress(),
        oracle.address,
        treasury.address,
        relayer.address,
        [admin1.address, admin2.address, admin3.address],
        2,
      );
      await spareEscrow.waitForDeployment();

      expect(await spareEscrow.requiredApprovals()).to.equal(2);
      expect(await spareEscrow.isAdmin(admin3.address)).to.be.true;
    });
  });
}

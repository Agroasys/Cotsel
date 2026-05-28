/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { AgroasysEscrow, MockUSDC } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';

describe('AgroasysEscrow', function () {
  let escrow: AgroasysEscrow;
  let usdc: MockUSDC;
  let buyer: SignerWithAddress;
  let supplier: SignerWithAddress;
  let treasury: SignerWithAddress;
  let oracle: SignerWithAddress;
  let admin1: SignerWithAddress;
  let admin2: SignerWithAddress;
  let admin3: SignerWithAddress;

  async function createSignature(
    signer: SignerWithAddress,
    contractAddr: string,
    buyerAddr: string,
    supplierAddr: string,
    totalAmount: bigint,
    logisticsAmount: bigint,
    platformFeesAmount: bigint,
    supplierFirstTranche: bigint,
    supplierSecondTranche: bigint,
    ricardianHash: string,
    nonce: bigint,
    deadline: bigint,
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const treasuryAddr = treasury.address;

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'uint256',
        'address',
        'address',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'bytes32',
        'uint256',
        'uint256',
      ],
      [
        chainId,
        contractAddr,
        buyerAddr,
        supplierAddr,
        treasuryAddr,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
      ],
    );

    const messageHash = ethers.keccak256(encoded);
    return await signer.signMessage(ethers.getBytes(messageHash));
  }

  async function signCreateTradeAuthorization(
    signer: SignerWithAddress,
    params: {
      buyer: string;
      supplier: string;
      totalAmount: bigint;
      logisticsAmount: bigint;
      platformFeesAmount: bigint;
      supplierFirstTranche: bigint;
      supplierSecondTranche: bigint;
      ricardianHash: string;
      nonce: bigint;
      deadline: bigint;
    },
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer.signTypedData(
      {
        name: 'AgroasysEscrow',
        version: '1',
        chainId,
        verifyingContract: await escrow.getAddress(),
      },
      {
        CreateTradeAuthorization: [
          { name: 'buyer', type: 'address' },
          { name: 'supplier', type: 'address' },
          { name: 'totalAmount', type: 'uint256' },
          { name: 'logisticsAmount', type: 'uint256' },
          { name: 'platformFeesAmount', type: 'uint256' },
          { name: 'supplierFirstTranche', type: 'uint256' },
          { name: 'supplierSecondTranche', type: 'uint256' },
          { name: 'ricardianHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      params,
    );
  }

  async function signUserActionAuthorization(
    signer: SignerWithAddress,
    params: {
      user: string;
      action: number;
      tradeId: bigint;
      nonce: bigint;
      deadline: bigint;
    },
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer.signTypedData(
      {
        name: 'AgroasysEscrow',
        version: '1',
        chainId,
        verifyingContract: await escrow.getAddress(),
      },
      {
        UserActionAuthorization: [
          { name: 'user', type: 'address' },
          { name: 'action', type: 'uint8' },
          { name: 'tradeId', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      params,
    );
  }

  async function signUsdcReceiveAuthorization(
    signer: SignerWithAddress,
    params: {
      from: string;
      to: string;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: string;
    },
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const signature = await signer.signTypedData(
      {
        name: 'Mock USDC',
        version: '2',
        chainId,
        verifyingContract: await usdc.getAddress(),
      },
      {
        ReceiveWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      params,
    );
    return ethers.Signature.from(signature);
  }

  async function createDefaultTrade(ricardianHash: string = ethers.id('trade-hash')) {
    const totalAmount = ethers.parseUnits('107000', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('2000', 6);
    const supplierFirstTranche = ethers.parseUnits('40000', 6);
    const supplierSecondTranche = ethers.parseUnits('60000', 6);

    const nonce = await escrow.getBuyerNonce(buyer.address);
    const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
    const deadline = BigInt(blockTimestamp + 3600);

    await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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

    await escrow
      .connect(buyer)
      .createTrade(
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

    return {
      tradeId: 0n,
      totalAmount,
      logisticsAmount,
      platformFeesAmount,
      supplierFirstTranche,
      supplierSecondTranche,
    };
  }

  async function unpauseWithQuorum() {
    await escrow.connect(admin1).proposeUnpause();
    await escrow.connect(admin2).approveUnpause();
  }

  async function rotateTreasuryPayoutReceiver(newReceiver: string, proposalId: bigint = 0n) {
    await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(newReceiver);
    await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(proposalId);
    await time.increase(24 * 3600 + 1);
    await escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(proposalId);
  }

  beforeEach(async function () {
    [buyer, supplier, treasury, oracle, admin1, admin2, admin3] = await ethers.getSigners();

    const USDCFactory = await ethers.getContractFactory('MockUSDC');
    usdc = await USDCFactory.deploy();
    await usdc.waitForDeployment();

    await usdc.mint(buyer.address, ethers.parseUnits('1000000', 6));

    const EscrowFactory = await ethers.getContractFactory('AgroasysEscrow');
    const admins = [admin1.address, admin2.address, admin3.address];
    escrow = await EscrowFactory.deploy(
      await usdc.getAddress(),
      oracle.address,
      treasury.address,
      admins,
      2,
    );
    await escrow.waitForDeployment();
  });

  describe('Deployment', function () {
    it('Should set correct initial values', async function () {
      expect(await escrow.oracleAddress()).to.equal(oracle.address);
      expect(await escrow.treasuryAddress()).to.equal(treasury.address);
      expect(await escrow.treasuryPayoutAddress()).to.equal(treasury.address);
      expect(await escrow.requiredApprovals()).to.equal(2);
      expect(await escrow.governanceTimelock()).to.equal(24 * 3600);
      expect(await escrow.oracleActive()).to.be.true;
      expect(await escrow.paused()).to.be.false;
      expect(await escrow.claimsPaused()).to.be.false;
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
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('invalid token');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          treasury.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('invalid oracle');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          ethers.ZeroAddress,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('invalid treasury');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          [admin1.address],
          0,
        ),
      ).to.be.revertedWith('required approvals must be >= 2');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('required approvals must be >= 2');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          [admin1.address, admin2.address],
          3,
        ),
      ).to.be.revertedWith('not enough admins');
    });
  });

  describe('Emergency Controls', function () {
    it('Should pause/unpause and block normal state transitions while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('pause-trade'));

      await expect(escrow.connect(admin1).pause())
        .to.emit(escrow, 'Paused')
        .withArgs(admin1.address);

      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId)).to.be.revertedWith('paused');

      await escrow.connect(admin1).proposeUnpause();
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
        [admin1.address, admin2.address],
        2,
      );
      await quorumEscrow.waitForDeployment();

      await expect(quorumEscrow.connect(admin1).pause())
        .to.emit(quorumEscrow, 'Paused')
        .withArgs(admin1.address);

      await expect(quorumEscrow.connect(admin1).proposeUnpause())
        .to.emit(quorumEscrow, 'UnpauseApproved')
        .withArgs(admin1.address, 1, 2);

      await expect(quorumEscrow.connect(admin2).approveUnpause())
        .to.emit(quorumEscrow, 'UnpauseApproved')
        .withArgs(admin2.address, 2, 2)
        .and.to.emit(quorumEscrow, 'Unpaused')
        .withArgs(admin2.address);
    });

    it('Should direct-transfer buyer refund before global pause', async function () {
      const { tradeId, supplierFirstTranche, supplierSecondTranche } = await createDefaultTrade(
        ethers.id('pause-refund-flow'),
      );
      const buyerBalBefore = await usdc.balanceOf(buyer.address);
      const refundablePrincipal = supplierFirstTranche + supplierSecondTranche;
      await time.increase(7 * 24 * 3600 + 1);
      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId))
        .to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, refundablePrincipal, 4, buyer.address);

      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + refundablePrincipal);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);

      await escrow.connect(admin1).pause();
    });

    it('Should keep buyer refunds automatic even when treasury claims are paused', async function () {
      const { tradeId, supplierFirstTranche, supplierSecondTranche } = await createDefaultTrade(
        ethers.id('claims-paused-buyer-refund'),
      );
      const buyerBalBefore = await usdc.balanceOf(buyer.address);
      const refundablePrincipal = supplierFirstTranche + supplierSecondTranche;

      await expect(escrow.connect(admin1).pauseClaims())
        .to.emit(escrow, 'ClaimsPaused')
        .withArgs(admin1.address);
      expect(await escrow.claimsPaused()).to.equal(true);

      await time.increase(7 * 24 * 3600 + 1);
      await escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + refundablePrincipal);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);

      await expect(escrow.connect(admin2).unpauseClaims())
        .to.emit(escrow, 'ClaimsUnpaused')
        .withArgs(admin2.address);
      expect(await escrow.claimsPaused()).to.equal(false);
    });

    it('Should restrict claim freeze controls to admins', async function () {
      await expect(escrow.connect(buyer).pauseClaims()).to.be.revertedWith('only admin');
      await escrow.connect(admin1).pauseClaims();
      await expect(escrow.connect(buyer).unpauseClaims()).to.be.revertedWith('only admin');
      await escrow.connect(admin2).unpauseClaims();
    });

    it('Should disable oracle in emergency and require governance recovery before unpause', async function () {
      await expect(escrow.connect(admin1).disableOracleEmergency())
        .to.emit(escrow, 'Paused')
        .withArgs(admin1.address)
        .and.to.emit(escrow, 'OracleDisabledEmergency')
        .withArgs(admin1.address, oracle.address);

      expect(await escrow.oracleActive()).to.be.false;
      expect(await escrow.paused()).to.be.true;

      await expect(escrow.connect(admin1).proposeUnpause()).to.be.revertedWith('oracle disabled');

      await expect(escrow.connect(oracle).confirmArrival(0)).to.be.revertedWith('oracle disabled');

      const newOracle = admin3.address;
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

      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId)).to.be.revertedWith(
        'oracle disabled',
      );

      const newOracle = admin3.address;
      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await escrow.connect(admin1).executeOracleUpdate(0);
      await unpauseWithQuorum();

      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId)).to.be.revertedWith(
        'only oracle',
      );

      await expect(escrow.connect(admin3).releaseFundsStage1(tradeId)).to.emit(
        escrow,
        'FundsReleasedStage1',
      );
    });

    it('Should reject pause and emergency controls from non-admin callers', async function () {
      await expect(escrow.connect(buyer).pause()).to.be.revertedWith('only admin');

      await expect(escrow.connect(buyer).disableOracleEmergency()).to.be.revertedWith('only admin');

      await escrow.connect(admin1).pause();

      await expect(escrow.connect(buyer).proposeUnpause()).to.be.revertedWith('only admin');

      await escrow.connect(admin1).proposeUnpause();

      await expect(escrow.connect(buyer).approveUnpause()).to.be.revertedWith('only admin');

      await expect(escrow.connect(buyer).cancelUnpauseProposal()).to.be.revertedWith('only admin');
    });
  });

  describe('Paused Matrix Hardening', function () {
    it('Should block createTrade while paused', async function () {
      const totalAmount = ethers.parseUnits('107000', 6);
      const logisticsAmount = ethers.parseUnits('5000', 6);
      const platformFeesAmount = ethers.parseUnits('2000', 6);
      const supplierFirstTranche = ethers.parseUnits('40000', 6);
      const supplierSecondTranche = ethers.parseUnits('60000', 6);
      const ricardianHash = ethers.id('paused-create');
      const nonce = await escrow.getBuyerNonce(buyer.address);
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
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('paused');
    });

    it('Should block release, confirm, open dispute, and finalize while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-flow'));

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId)).to.be.revertedWith('paused');
      await unpauseWithQuorum();

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(oracle).confirmArrival(tradeId)).to.be.revertedWith('paused');
      await unpauseWithQuorum();

      await escrow.connect(oracle).confirmArrival(tradeId);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(buyer).openDispute(tradeId)).to.be.revertedWith('paused');
      await unpauseWithQuorum();

      await time.increase(24 * 3600 + 1);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(buyer).finalizeAfterDisputeWindow(tradeId)).to.be.revertedWith(
        'paused',
      );
    });

    it('Should block dispute propose/approve while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-dispute'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(admin1).proposeDisputeSolution(tradeId, 0)).to.be.revertedWith(
        'paused',
      );
      await unpauseWithQuorum();

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWith('paused');
    });

    it('Should allow governance recovery paths while paused', async function () {
      await escrow.connect(admin1).pause();

      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.emit(escrow, 'OracleUpdated');

      await escrow.connect(admin1).proposeAddAdmin(buyer.address);
      await escrow.connect(admin2).approveAddAdmin(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeAddAdmin(0))
        .to.emit(escrow, 'AdminAdded')
        .withArgs(buyer.address);

      await escrow.connect(admin1).proposeOracleUpdate(oracle.address);
      const governanceTtl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(governanceTtl + 1n);
      await expect(escrow.connect(admin2).cancelExpiredOracleUpdateProposal(1))
        .to.emit(escrow, 'OracleUpdateProposalExpiredCancelled')
        .withArgs(1, admin2.address);

      await escrow.connect(admin1).proposeAddAdmin(treasury.address);
      await time.increase(governanceTtl + 1n);
      await expect(escrow.connect(admin2).cancelExpiredAddAdminProposal(1))
        .to.emit(escrow, 'AdminAddProposalExpiredCancelled')
        .withArgs(1, admin2.address);

      expect(await escrow.paused()).to.be.true;
    });

    it('Should block LOCK timeout cancel while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-lock-timeout'));
      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)).to.be.revertedWith(
        'paused',
      );
    });

    it('Should block IN_TRANSIT timeout refund while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-in-transit-timeout'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(escrow.connect(buyer).refundInTransitAfterTimeout(tradeId)).to.be.revertedWith(
        'paused',
      );
    });
  });

  describe('Timeout Escape Hatches', function () {
    it('Should allow buyer to cancel a LOCKED trade after LOCK_TIMEOUT', async function () {
      const {
        tradeId,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
      } = await createDefaultTrade(ethers.id('lock-timeout'));
      const buyerBalBefore = await usdc.balanceOf(buyer.address);
      const refundablePrincipal = supplierFirstTranche + supplierSecondTranche;

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId))
        .to.emit(escrow, 'TradeCancelledAfterLockTimeout')
        .withArgs(tradeId, buyer.address, refundablePrincipal)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, refundablePrincipal, 4, buyer.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        logisticsAmount + platformFeesAmount,
      );
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + refundablePrincipal);
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

      await expect(escrow.connect(buyer).refundInTransitAfterTimeout(tradeId))
        .to.emit(escrow, 'InTransitTimeoutRefunded')
        .withArgs(tradeId, buyer.address, supplierSecondTranche)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, supplierSecondTranche, 5, buyer.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + supplierSecondTranche);
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it('Should prevent buyer to cancel a LOCKED trade before LOCK_TIMEOUT', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('lock-timeout'));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout - 1n);

      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)).to.be.revertedWith(
        'lock timeout not elapsed',
      );
    });

    it('Should prevent buyer to refund only remaining principal before IN_TRANSIT timeout', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('in-transit-timeout'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout - 1n);

      await expect(escrow.connect(buyer).refundInTransitAfterTimeout(tradeId)).to.be.revertedWith(
        'in-transit timeout not elapsed',
      );
    });

    it('Should prevent a second LOCK timeout cancellation', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('lock-timeout-double'));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId);

      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)).to.be.revertedWith(
        'status must be LOCKED',
      );
    });

    it('Should prevent a second IN_TRANSIT timeout refund', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('in-transit-timeout-double'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await escrow.connect(buyer).refundInTransitAfterTimeout(tradeId);

      await expect(escrow.connect(buyer).refundInTransitAfterTimeout(tradeId)).to.be.revertedWith(
        'status must be IN_TRANSIT',
      );
    });
  });

  describe('Treasury Leakage Guards', function () {
    it('Should keep non-refundable fees claimable by treasury on LOCK timeout cancellation', async function () {
      const {
        tradeId,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
      } = await createDefaultTrade(ethers.id('treasury-lock-timeout'));
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const refundablePrincipal = supplierFirstTranche + supplierSecondTranche;

      expect(await escrow.nonRefundableFeeAmount(tradeId)).to.equal(
        logisticsAmount + platformFeesAmount,
      );
      expect(await escrow.buyerRefundableAmount(tradeId)).to.equal(refundablePrincipal);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);
      await escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        logisticsAmount + platformFeesAmount,
      );
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
      await escrow.connect(buyer).refundInTransitAfterTimeout(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeBalance);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(expectedTreasuryClaimable);
    });

    it('Should keep treasury at fees-only after dispute REFUND', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-dispute-refund'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });

    it('Should keep treasury at fees-only after dispute RESOLVE', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-dispute-resolve'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 1);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });
  });

  describe('Automatic Payout Flow', function () {
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
      await escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId);
      const buyerAfterRefund = await usdc.balanceOf(buyer.address);

      expect(buyerAfterRefund).to.be.gt(buyerBefore);
      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)).to.be.revertedWith(
        'status must be LOCKED',
      );
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerAfterRefund);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
    });
  });

  describe('Treasury Sweep', function () {
    it('Should allow treasury/admin destination-locked treasury sweep', async function () {
      const { tradeId, logisticsAmount, platformFeesAmount } = await createDefaultTrade(
        ethers.id('treasury-sweep-destination-locked'),
      );
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await rotateTreasuryPayoutReceiver(admin3.address);

      const expectedTreasuryClaimable = logisticsAmount + platformFeesAmount;
      const callerBefore = await usdc.balanceOf(admin1.address);
      const receiverBefore = await usdc.balanceOf(admin3.address);
      const supplierClaimableBefore = await escrow.claimableUsdc(supplier.address);
      const buyerClaimableBefore = await escrow.claimableUsdc(buyer.address);

      await expect(escrow.connect(admin1).claimTreasury())
        .to.emit(escrow, 'TreasuryClaimed')
        .withArgs(treasury.address, admin3.address, expectedTreasuryClaimable, admin1.address);

      expect(await usdc.balanceOf(admin1.address)).to.equal(callerBefore);
      expect(await usdc.balanceOf(admin3.address)).to.equal(
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

      await expect(escrow.connect(buyer).claimTreasury()).to.be.revertedWith(
        'only treasury or admin',
      );
    });

    it('Should reject treasury sweep when no treasury claimable exists', async function () {
      await expect(escrow.connect(treasury).claimTreasury()).to.be.revertedWith(
        'nothing treasury claimable',
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
      await expect(escrow.connect(treasury).claimTreasury()).to.be.revertedWith('claims paused');
    });
  });

  describe('createTrade', function () {
    const totalAmount = ethers.parseUnits('107000', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('2000', 6);
    const supplierFirstTranche = ethers.parseUnits('40000', 6);
    const supplierSecondTranche = ethers.parseUnits('60000', 6);
    const ricardianHash = ethers.id('trade-contract-hash');

    it('Should create a trade with valid signature', async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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

      const tx = await escrow
        .connect(buyer)
        .createTrade(
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
      expect(await escrow.getBuyerNonce(buyer.address)).to.equal(nonce + 1n);
    });

    it('Should create multiple trades with incrementing nonces', async function () {
      const amount = ethers.parseUnits('107000', 6);
      const hash1 = ethers.id('hash1');
      const hash2 = ethers.id('hash2');

      await usdc.connect(buyer).approve(await escrow.getAddress(), amount * 2n);

      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      const nonce0 = await escrow.getBuyerNonce(buyer.address);

      // First trade with nonce 0
      const sig1 = await createSignature(
        buyer,
        await escrow.getAddress(),
        buyer.address,
        supplier.address,
        amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        hash1,
        nonce0,
        deadline,
      );

      await escrow
        .connect(buyer)
        .createTrade(
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

      const nonce1 = await escrow.getBuyerNonce(buyer.address);
      // Second trade with nonce 1
      const sig2 = await createSignature(
        buyer,
        await escrow.getAddress(),
        buyer.address,
        supplier.address,
        amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        hash2,
        nonce1,
        deadline,
      );

      await escrow
        .connect(buyer)
        .createTrade(
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
      expect(await escrow.getBuyerNonce(buyer.address)).to.equal(2);
    });

    it('Should reject invalid signature (wrong signer)', async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('bad signature');
    });

    it('Should reject replay signature', async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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

      const tx = await escrow
        .connect(buyer)
        .createTrade(
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
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('bad nonce'); // got rejected because of the nonce
    });

    it('Should reject with invalid parameters (zero addresses, bad hash, mismatched amounts)', async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await expect(
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('supplier required');

      await expect(
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('supplier cannot be escrow');

      await expect(
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('ricardian hash required');

      const wrongTotal = ethers.parseUnits('100000', 6);
      await expect(
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('breakdown mismatch');
    });

    it('Should reject with bad nonce', async function () {
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const wrongNonce = 5n;

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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
        wrongNonce,
        deadline,
      );

      await expect(
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('bad nonce');
    });

    it('Should reject expired signature', async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const expiredDeadline = BigInt(blockTimestamp - 100);

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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
        expiredDeadline,
      );

      await expect(
        escrow
          .connect(buyer)
          .createTrade(
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
      ).to.be.revertedWith('signature expired');
    });
  });

  describe('Gasless typed authorizations', function () {
    const totalAmount = ethers.parseUnits('107000', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('2000', 6);
    const supplierFirstTranche = ethers.parseUnits('40000', 6);
    const supplierSecondTranche = ethers.parseUnits('60000', 6);

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
          await escrow.ACTION_CREATE_TRADE(),
          0n,
          admin1.address,
          prepared.authDeadline,
        );
      await expect(tx)
        .to.emit(escrow, 'GaslessTradeFunded')
        .withArgs(0n, buyer.address, prepared.tokenNonce, totalAmount);
      await expect(tx)
        .to.emit(escrow, 'RelayedActionExecuted')
        .withArgs(admin1.address, buyer.address, await escrow.ACTION_CREATE_TRADE(), 0n);

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

      await expect(submitPreparedGaslessTrade(prepared)).to.be.revertedWith(
        'bad authorization nonce',
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
      ).to.be.revertedWith('breakdown mismatch');

      expect(await usdc.authorizationState(buyer.address, prepared.tokenNonce)).to.equal(false);
    });

    it('rejects expired and wrong-signer gasless create-trade authorizations', async function () {
      const prepared = await prepareGaslessTrade(ethers.id('gasless-expired'));
      await time.increase(3601);

      await expect(submitPreparedGaslessTrade(prepared)).to.be.revertedWith(
        'authorization expired',
      );
      expect(await usdc.authorizationState(buyer.address, prepared.tokenNonce)).to.equal(false);

      const freshPrepared = await prepareGaslessTrade(ethers.id('gasless-wrong-signer'));
      const wrongSignerSignature = await signCreateTradeAuthorization(supplier, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash: freshPrepared.ricardianHash,
        nonce: freshPrepared.authNonce,
        deadline: freshPrepared.authDeadline,
      });

      await expect(
        submitPreparedGaslessTrade({
          ...freshPrepared,
          authorizationSignature: wrongSignerSignature,
        }),
      ).to.be.revertedWith('bad authorization');
      expect(await usdc.authorizationState(buyer.address, freshPrepared.tokenNonce)).to.equal(
        false,
      );
    });

    it('executes buyer actions only through admins or allowlisted relayers', async function () {
      const { tradeId } = await createGaslessTrade(ethers.id('gasless-action'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);

      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
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
      ).to.be.revertedWith('only relayer or admin');

      await expect(escrow.connect(admin1).setRelayer(supplier.address, true))
        .to.emit(escrow, 'RelayerUpdated')
        .withArgs(supplier.address, true, admin1.address);

      await expect(
        escrow.connect(supplier).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      )
        .to.emit(escrow, 'RelayedActionExecuted')
        .withArgs(supplier.address, buyer.address, await escrow.ACTION_OPEN_DISPUTE(), tradeId);

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(3);
    });

    it('rejects replayed, expired, and wrong-trade buyer action authorizations', async function () {
      const { tradeId } = await createGaslessTrade(ethers.id('gasless-action-failures'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);

      let blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      let deadline = BigInt(blockTimestamp + 3600);
      const nonce = await escrow.getAuthorizationNonce(buyer.address);
      let signature = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 1,
        tradeId: tradeId + 1n,
        nonce,
        deadline,
      });

      await expect(
        escrow.connect(admin1).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      ).to.be.revertedWith('bad authorization');

      blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const expiredDeadline = BigInt(blockTimestamp - 1);
      signature = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 1,
        tradeId,
        nonce,
        deadline: expiredDeadline,
      });

      await expect(
        escrow
          .connect(admin1)
          .openDisputeWithAuthorization(tradeId, nonce, expiredDeadline, signature),
      ).to.be.revertedWith('authorization expired');

      blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      deadline = BigInt(blockTimestamp + 3600);
      signature = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 1,
        tradeId,
        nonce,
        deadline,
      });

      await escrow
        .connect(admin1)
        .openDisputeWithAuthorization(tradeId, nonce, deadline, signature);
      await expect(
        escrow.connect(admin1).openDisputeWithAuthorization(tradeId, nonce, deadline, signature),
      ).to.be.revertedWith('bad authorization nonce');
    });

    it('relays lock-timeout cancellation and transfers only refundable principal to the buyer', async function () {
      const { tradeId } = await createGaslessTrade(ethers.id('gasless-cancel-timeout'));
      await time.increase(7 * 24 * 3600 + 1);

      const buyerBefore = await usdc.balanceOf(buyer.address);
      const nonce = await escrow.getAuthorizationNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const signature = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 2,
        tradeId,
        nonce,
        deadline,
      });

      await expect(
        escrow
          .connect(admin1)
          .cancelLockedTradeAfterTimeoutWithAuthorization(tradeId, nonce, deadline, signature),
      )
        .to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(
          tradeId,
          buyer.address,
          supplierFirstTranche + supplierSecondTranche,
          4,
          admin1.address,
        )
        .and.to.emit(escrow, 'RelayedActionExecuted')
        .withArgs(
          admin1.address,
          buyer.address,
          await escrow.ACTION_CANCEL_LOCKED_TIMEOUT(),
          tradeId,
        );

      expect(await usdc.balanceOf(buyer.address)).to.equal(
        buyerBefore + supplierFirstTranche + supplierSecondTranche,
      );
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        logisticsAmount + platformFeesAmount,
      );
    });

    it('relays in-transit timeout refunds directly to the buyer', async function () {
      const { tradeId } = await createGaslessTrade(ethers.id('gasless-in-transit-refund'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await time.increase(14 * 24 * 3600 + 1);

      const buyerBefore = await usdc.balanceOf(buyer.address);
      const nonce = await escrow.getAuthorizationNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const signature = await signUserActionAuthorization(buyer, {
        user: buyer.address,
        action: 3,
        tradeId,
        nonce,
        deadline,
      });

      await expect(
        escrow
          .connect(admin1)
          .refundInTransitAfterTimeoutWithAuthorization(tradeId, nonce, deadline, signature),
      )
        .to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, supplierSecondTranche, 5, admin1.address)
        .and.to.emit(escrow, 'RelayedActionExecuted')
        .withArgs(
          admin1.address,
          buyer.address,
          await escrow.ACTION_REFUND_IN_TRANSIT_TIMEOUT(),
          tradeId,
        );

      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBefore + supplierSecondTranche);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
    });
  });

  describe('Complete Flow (Without dispute)', function () {
    let tradeId: bigint;
    const totalAmount = ethers.parseUnits('107000', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('2000', 6);
    const supplierFirstTranche = ethers.parseUnits('40000', 6);
    const supplierSecondTranche = ethers.parseUnits('60000', 6);

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const ricardianHash = ethers.id('trade-hash');

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

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

      await escrow
        .connect(buyer)
        .createTrade(
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

      await expect(escrow.connect(oracle).confirmArrival(tradeId)).to.emit(
        escrow,
        'ArrivalConfirmed',
      );

      trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(2); // ARRIVAL_CONFIRMED

      await time.increase(24 * 3600 + 1);

      const supplierBalBeforeStage2 = await usdc.balanceOf(supplier.address);

      await expect(escrow.connect(buyer).finalizeAfterDisputeWindow(tradeId)).to.emit(
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
    let tradeId: bigint;

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const totalAmount = ethers.parseUnits('107000', 6);
      const ricardianHash = ethers.id('trade-hash');

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer,
        await escrow.getAddress(),
        buyer.address,
        supplier.address,
        totalAmount,
        ethers.parseUnits('5000', 6),
        ethers.parseUnits('2000', 6),
        ethers.parseUnits('40000', 6),
        ethers.parseUnits('60000', 6),
        ricardianHash,
        nonce,
        deadline,
      );

      await escrow
        .connect(buyer)
        .createTrade(
          supplier.address,
          totalAmount,
          ethers.parseUnits('5000', 6),
          ethers.parseUnits('2000', 6),
          ethers.parseUnits('40000', 6),
          ethers.parseUnits('60000', 6),
          ricardianHash,
          nonce,
          deadline,
          signature,
        );

      tradeId = 0n;
    });

    it('Should reject if not oracle', async function () {
      await expect(escrow.connect(buyer).releaseFundsStage1(tradeId)).to.be.revertedWith(
        'only oracle',
      );
    });

    it('Should reject if wrong status', async function () {
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId)).to.be.revertedWith(
        'status must be LOCKED',
      );
    });
  });

  describe('confirmArrival', function () {
    let tradeId: bigint;

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const totalAmount = ethers.parseUnits('107000', 6);
      const ricardianHash = ethers.id('trade-hash');

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer,
        await escrow.getAddress(),
        buyer.address,
        supplier.address,
        totalAmount,
        ethers.parseUnits('5000', 6),
        ethers.parseUnits('2000', 6),
        ethers.parseUnits('40000', 6),
        ethers.parseUnits('60000', 6),
        ricardianHash,
        nonce,
        deadline,
      );

      await escrow
        .connect(buyer)
        .createTrade(
          supplier.address,
          totalAmount,
          ethers.parseUnits('5000', 6),
          ethers.parseUnits('2000', 6),
          ethers.parseUnits('40000', 6),
          ethers.parseUnits('60000', 6),
          ricardianHash,
          nonce,
          deadline,
          signature,
        );

      tradeId = 0n;
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
    });

    it('Should confirm arrival', async function () {
      await expect(escrow.connect(oracle).confirmArrival(tradeId)).to.emit(
        escrow,
        'ArrivalConfirmed',
      );

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(2); // ARRIVAL_CONFIRMED
      expect(trade.arrivalTimestamp).to.be.gt(0);
    });

    it('Should reject if not oracle', async function () {
      await expect(escrow.connect(buyer).confirmArrival(tradeId)).to.be.revertedWith('only oracle');
    });

    it('Should reject if wrong status', async function () {
      await escrow.connect(oracle).confirmArrival(tradeId);

      await expect(escrow.connect(oracle).confirmArrival(tradeId)).to.be.revertedWith(
        'status must be IN_TRANSIT',
      );
    });
  });

  describe('Dispute Flow', function () {
    let tradeId: bigint;
    const supplierSecondTranche = ethers.parseUnits('60000', 6);
    const supplierFirstTranche = ethers.parseUnits('40000', 6);
    const logistics = ethers.parseUnits('5000', 6);
    const fees = ethers.parseUnits('2000', 6);
    const totalAmount = ethers.parseUnits('107000', 6);

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const ricardianHash = ethers.id('trade-hash');

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer,
        await escrow.getAddress(),
        buyer.address,
        supplier.address,
        totalAmount,
        logistics,
        fees,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
      );

      await escrow
        .connect(buyer)
        .createTrade(
          supplier.address,
          totalAmount,
          logistics,
          fees,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          nonce,
          deadline,
          signature,
        );

      tradeId = 0n;
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
    });

    it('Should allow buyer to open dispute within 24h', async function () {
      await expect(escrow.connect(buyer).openDispute(tradeId)).to.emit(
        escrow,
        'DisputeOpenedByBuyer',
      );

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(3); // FROZEN
    });

    it('Should reject dispute after 24h window', async function () {
      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(buyer).openDispute(tradeId)).to.be.revertedWith('window closed');
    });

    it('Should reject dispute from non-buyer', async function () {
      await expect(escrow.connect(supplier).openDispute(tradeId)).to.be.revertedWith('only buyer');
    });

    it('Should refund buyer after dispute REFUND resolution', async function () {
      await escrow.connect(buyer).openDispute(tradeId);

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
      await escrow.connect(buyer).openDispute(tradeId);

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
      await escrow.connect(buyer).openDispute(tradeId);

      await expect(escrow.connect(buyer).proposeDisputeSolution(tradeId, 0)).to.be.revertedWith(
        'only admin',
      );
    });

    it('Should reject dispute approval from non-admin', async function () {
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await expect(escrow.connect(buyer).approveDisputeSolution(0)).to.be.revertedWith(
        'only admin',
      );
    });

    it('Should enforce dispute proposal expiry and allow manual cancellation', async function () {
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWith(
        'proposal expired',
      );

      await expect(escrow.connect(admin2).cancelExpiredDisputeProposal(0))
        .to.emit(escrow, 'DisputeProposalExpiredCancelled')
        .withArgs(0, tradeId, admin2.address);

      await expect(escrow.connect(admin2).proposeDisputeSolution(tradeId, 1))
        .to.emit(escrow, 'DisputeSolutionProposed')
        .withArgs(1, tradeId, 1, admin2.address);
    });

    it('Should auto-cancel expired active proposal when replacing with a new one', async function () {
      await escrow.connect(buyer).openDispute(tradeId);
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

  describe('Governance: Oracle Update', function () {
    it('Should update oracle with timelock', async function () {
      const newOracle = admin3.address;

      await escrow.connect(admin1).proposeOracleUpdate(newOracle);

      await escrow.connect(admin2).approveOracleUpdate(0);

      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, 'OracleUpdated')
        .withArgs(oracle.address, newOracle);

      expect(await escrow.oracleAddress()).to.equal(newOracle);
    });

    it('Should reject execution before timelock', async function () {
      const newOracle = admin3.address;

      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWith(
        'timelock not elapsed',
      );
    });

    it('Should reject oracle update from non-admin', async function () {
      await expect(escrow.connect(buyer).proposeOracleUpdate(admin3.address)).to.be.revertedWith(
        'only admin',
      );
    });

    it('Should reject execution after proposal expiry and allow cancel', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWith(
        'proposal expired',
      );

      await expect(escrow.connect(admin2).cancelExpiredOracleUpdateProposal(0))
        .to.emit(escrow, 'OracleUpdateProposalExpiredCancelled')
        .withArgs(0, admin2.address);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWith(
        'proposal cancelled',
      );
    });
  });

  describe('Governance: Add Admin', function () {
    it('Should add new admin with timelock', async function () {
      const newAdmin = buyer.address;

      await escrow.connect(admin1).proposeAddAdmin(newAdmin);

      await escrow.connect(admin2).approveAddAdmin(0);

      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(admin1).executeAddAdmin(0))
        .to.emit(escrow, 'AdminAdded')
        .withArgs(newAdmin);

      expect(await escrow.isAdmin(newAdmin)).to.be.true;
    });

    it('Should reject add admin from non-admin', async function () {
      await expect(escrow.connect(buyer).proposeAddAdmin(buyer.address)).to.be.revertedWith(
        'only admin',
      );
    });

    it('Should reject execution after proposal expiry and allow cancel', async function () {
      await escrow.connect(admin1).proposeAddAdmin(buyer.address);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin1).executeAddAdmin(0)).to.be.revertedWith(
        'proposal expired',
      );

      await expect(escrow.connect(admin2).cancelExpiredAddAdminProposal(0))
        .to.emit(escrow, 'AdminAddProposalExpiredCancelled')
        .withArgs(0, admin2.address);

      await expect(escrow.connect(admin1).executeAddAdmin(0)).to.be.revertedWith(
        'proposal cancelled',
      );
    });
  });

  describe('Governance: Treasury Payout Receiver', function () {
    it('Should rotate treasury payout receiver with quorum and timelock', async function () {
      const newReceiver = admin3.address;

      await expect(
        escrow.connect(buyer).proposeTreasuryPayoutAddressUpdate(newReceiver),
      ).to.be.revertedWith('only admin');

      await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(newReceiver);
      await expect(escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0)).to.be.revertedWith(
        'not enough approvals',
      );

      await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(0);
      await expect(escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0)).to.be.revertedWith(
        'timelock not elapsed',
      );

      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0))
        .to.emit(escrow, 'TreasuryPayoutAddressUpdated')
        .withArgs(treasury.address, newReceiver);

      expect(await escrow.treasuryPayoutAddress()).to.equal(newReceiver);
    });

    it('Should reject invalid treasury payout receiver update proposals', async function () {
      await expect(
        escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(ethers.ZeroAddress),
      ).to.be.revertedWith('invalid treasury payout receiver');

      await expect(
        escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(treasury.address),
      ).to.be.revertedWith('same treasury payout receiver');
    });

    it('Should reject execution after proposal expiry and allow cancel', async function () {
      await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(admin3.address);
      await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(0);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0)).to.be.revertedWith(
        'proposal expired',
      );

      await expect(escrow.connect(admin2).cancelExpiredTreasuryPayoutAddressUpdateProposal(0))
        .to.emit(escrow, 'TreasuryPayoutAddressUpdateProposalExpiredCancelled')
        .withArgs(0, admin2.address);

      await expect(escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0)).to.be.revertedWith(
        'proposal cancelled',
      );
    });

    it('Should keep trade signature flow valid after payout receiver rotation', async function () {
      await rotateTreasuryPayoutReceiver(admin3.address);
      const { tradeId } = await createDefaultTrade(ethers.id('sig-valid-after-payout-rotation'));
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(0); // LOCKED
      expect(await escrow.treasuryPayoutAddress()).to.equal(admin3.address);
      expect(await escrow.treasuryAddress()).to.equal(treasury.address);
    });
  });

  describe('Expiry Edge Boundaries', function () {
    it('Should allow dispute approval exactly at dispute TTL boundary', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('dispute-expiry-boundary-ok'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const proposal = await escrow.disputeProposals(0);
      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.setNextBlockTimestamp(proposal.createdAt + ttl);

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, 'DisputeFinalized')
        .withArgs(0, tradeId, 0);
    });

    it('Should reject dispute approval one second after dispute TTL boundary', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('dispute-expiry-boundary-fail'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const proposal = await escrow.disputeProposals(0);
      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.setNextBlockTimestamp(proposal.createdAt + ttl + 1n);

      await expect(escrow.connect(admin2).approveDisputeSolution(0)).to.be.revertedWith(
        'proposal expired',
      );
    });

    it('Should allow oracle governance execution exactly at governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);
      await escrow.connect(admin2).approveOracleUpdate(0);

      const expiresAt = await escrow.oracleUpdateProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt);

      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, 'OracleUpdated')
        .withArgs(oracle.address, admin3.address);
    });

    it('Should reject oracle governance execution one second after governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);
      await escrow.connect(admin2).approveOracleUpdate(0);

      const expiresAt = await escrow.oracleUpdateProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt + 1n);

      await expect(escrow.connect(admin1).executeOracleUpdate(0)).to.be.revertedWith(
        'proposal expired',
      );
    });

    it('Should allow add-admin governance execution exactly at governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeAddAdmin(buyer.address);
      await escrow.connect(admin2).approveAddAdmin(0);

      const expiresAt = await escrow.adminAddProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt);

      await expect(escrow.connect(admin1).executeAddAdmin(0))
        .to.emit(escrow, 'AdminAdded')
        .withArgs(buyer.address);
    });

    it('Should reject add-admin governance execution one second after governance TTL boundary', async function () {
      await escrow.connect(admin1).proposeAddAdmin(buyer.address);
      await escrow.connect(admin2).approveAddAdmin(0);

      const expiresAt = await escrow.adminAddProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt + 1n);

      await expect(escrow.connect(admin1).executeAddAdmin(0)).to.be.revertedWith(
        'proposal expired',
      );
    });
  });
});

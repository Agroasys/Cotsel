/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { AgroasysEscrow, MockUSDC } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AgroasysEscrow", function () {
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
    deadline: bigint
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const treasuryAddr = treasury.address;

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256", "address", "address", "address", "address",
        "uint256", "uint256", "uint256", "uint256", "uint256",
        "bytes32", "uint256", "uint256"
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
        deadline
      ]
    );

    const messageHash = ethers.keccak256(encoded);
    return await signer.signMessage(ethers.getBytes(messageHash));
  }

  async function createDefaultTrade(ricardianHash: string = ethers.id("trade-hash")) {
    const totalAmount = ethers.parseUnits("107000", 6);
    const logisticsAmount = ethers.parseUnits("5000", 6);
    const platformFeesAmount = ethers.parseUnits("2000", 6);
    const supplierFirstTranche = ethers.parseUnits("40000", 6);
    const supplierSecondTranche = ethers.parseUnits("60000", 6);

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
      deadline
    );

    await escrow.connect(buyer).createTrade(
      supplier.address,
      totalAmount,
      logisticsAmount,
      platformFeesAmount,
      supplierFirstTranche,
      supplierSecondTranche,
      ricardianHash,
      nonce,
      deadline,
      signature
    );

    return {
      tradeId: 0n,
      totalAmount,
      logisticsAmount,
      platformFeesAmount,
      supplierFirstTranche,
      supplierSecondTranche
    };
  }

  async function unpauseWithQuorum() {
    await escrow.connect(admin1).proposeUnpause();
    await escrow.connect(admin2).approveUnpause();
  }

  async function claimAndAssert(claimant: SignerWithAddress) {
    const claimable = await escrow.claimableUsdc(claimant.address);
    const before = await usdc.balanceOf(claimant.address);

    await expect(escrow.connect(claimant).claim())
      .to.emit(escrow, "Claimed")
      .withArgs(claimant.address, claimable);

    expect(await usdc.balanceOf(claimant.address)).to.equal(before + claimable);
    expect(await escrow.claimableUsdc(claimant.address)).to.equal(0);

    return claimable;
  }

  beforeEach(async function () {
    [buyer, supplier, treasury, oracle, admin1, admin2, admin3] = await ethers.getSigners();

    const USDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await USDCFactory.deploy();
    await usdc.waitForDeployment();

    await usdc.mint(buyer.address, ethers.parseUnits("1000000", 6));

    const EscrowFactory = await ethers.getContractFactory("AgroasysEscrow");
    const admins = [admin1.address, admin2.address, admin3.address];
    escrow = await EscrowFactory.deploy(
      await usdc.getAddress(),
      oracle.address,
      treasury.address,
      admins,
      2
    );
    await escrow.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set correct initial values", async function () {
      expect(await escrow.oracleAddress()).to.equal(oracle.address);
      expect(await escrow.treasuryAddress()).to.equal(treasury.address);
      expect(await escrow.requiredApprovals()).to.equal(2);
      expect(await escrow.governanceTimelock()).to.equal(24 * 3600);
      expect(await escrow.oracleActive()).to.be.true;
      expect(await escrow.paused()).to.be.false;
      expect(await escrow.claimsPaused()).to.be.false;
      expect(await escrow.isAdmin(admin1.address)).to.be.true;
      expect(await escrow.isAdmin(admin2.address)).to.be.true;
      expect(await escrow.isAdmin(admin3.address)).to.be.true;
    });

    it("Should reject invalid constructor params", async function () {
      const EscrowFactory = await ethers.getContractFactory("AgroasysEscrow");
      
      await expect(
        EscrowFactory.deploy(ethers.ZeroAddress, oracle.address, treasury.address, [admin1.address], 1)
      ).to.be.revertedWith("invalid token");

      await expect(
        EscrowFactory.deploy(await usdc.getAddress(), ethers.ZeroAddress, treasury.address, [admin1.address], 1)
      ).to.be.revertedWith("invalid oracle");

      await expect(
        EscrowFactory.deploy(await usdc.getAddress(), oracle.address, ethers.ZeroAddress, [admin1.address], 1)
      ).to.be.revertedWith("invalid treasury");

      await expect(
        EscrowFactory.deploy(await usdc.getAddress(), oracle.address, treasury.address, [admin1.address], 0)
      ).to.be.revertedWith("required approvals must be > 0");

      await expect(
        EscrowFactory.deploy(await usdc.getAddress(), oracle.address, treasury.address, [admin1.address], 3)
      ).to.be.revertedWith("not enough admins");
    });
  });

  describe("Emergency Controls", function () {
    it("Should pause/unpause and block normal state transitions while paused", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("pause-trade"));

      await expect(escrow.connect(admin1).pause())
        .to.emit(escrow, "Paused")
        .withArgs(admin1.address);

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId)
      ).to.be.revertedWith("paused");

      await escrow.connect(admin1).proposeUnpause();
      await expect(escrow.connect(admin2).approveUnpause())
        .to.emit(escrow, "Unpaused")
        .withArgs(admin2.address);

      await expect(escrow.connect(oracle).releaseFundsStage1(tradeId))
        .to.emit(escrow, "FundsReleasedStage1");
    });

    it("Should allow claims while globally paused when claim freeze is not active", async function () {
      const { tradeId, supplierFirstTranche } = await createDefaultTrade(ethers.id("pause-claim-flow"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(supplierFirstTranche);

      await escrow.connect(admin1).pause();
      await claimAndAssert(supplier);
    });

    it("Should enforce dedicated claim freeze and restore claim after unpauseClaims", async function () {
      const { tradeId, supplierFirstTranche } = await createDefaultTrade(ethers.id("claims-freeze-policy"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(supplierFirstTranche);

      await expect(escrow.connect(admin1).pauseClaims())
        .to.emit(escrow, "ClaimsPaused")
        .withArgs(admin1.address);
      expect(await escrow.claimsPaused()).to.equal(true);

      await expect(escrow.connect(supplier).claim()).to.be.revertedWith("claims paused");

      await escrow.connect(admin1).pause();
      await expect(escrow.connect(supplier).claim()).to.be.revertedWith("claims paused");

      await expect(escrow.connect(admin2).unpauseClaims())
        .to.emit(escrow, "ClaimsUnpaused")
        .withArgs(admin2.address);
      expect(await escrow.claimsPaused()).to.equal(false);

      await claimAndAssert(supplier);
    });

    it("Should restrict claim freeze controls to admins", async function () {
      await expect(escrow.connect(buyer).pauseClaims()).to.be.revertedWith("only admin");
      await escrow.connect(admin1).pauseClaims();
      await expect(escrow.connect(buyer).unpauseClaims()).to.be.revertedWith("only admin");
      await escrow.connect(admin2).unpauseClaims();
    });

    it("Should disable oracle in emergency and require governance recovery before unpause", async function () {
      await expect(escrow.connect(admin1).disableOracleEmergency())
        .to.emit(escrow, "Paused")
        .withArgs(admin1.address)
        .and.to.emit(escrow, "OracleDisabledEmergency")
        .withArgs(admin1.address, oracle.address);

      expect(await escrow.oracleActive()).to.be.false;
      expect(await escrow.paused()).to.be.true;

      await expect(
        escrow.connect(admin1).proposeUnpause()
      ).to.be.revertedWith("oracle disabled");

      await expect(
        escrow.connect(oracle).confirmArrival(0)
      ).to.be.revertedWith("oracle disabled");

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

    it("Should recover oracle flow end-to-end after emergency disable", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("oracle-recovery-e2e"));

      await escrow.connect(admin1).disableOracleEmergency();

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId)
      ).to.be.revertedWith("oracle disabled");

      const newOracle = admin3.address;
      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await escrow.connect(admin1).executeOracleUpdate(0);
      await unpauseWithQuorum();

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId)
      ).to.be.revertedWith("only oracle");

      await expect(escrow.connect(admin3).releaseFundsStage1(tradeId))
        .to.emit(escrow, "FundsReleasedStage1");
    });

    it("Should reject pause and emergency controls from non-admin callers", async function () {
      await expect(
        escrow.connect(buyer).pause()
      ).to.be.revertedWith("only admin");

      await expect(
        escrow.connect(buyer).disableOracleEmergency()
      ).to.be.revertedWith("only admin");

      await escrow.connect(admin1).pause();

      await expect(
        escrow.connect(buyer).proposeUnpause()
      ).to.be.revertedWith("only admin");

      await escrow.connect(admin1).proposeUnpause();

      await expect(
        escrow.connect(buyer).approveUnpause()
      ).to.be.revertedWith("only admin");

      await expect(
        escrow.connect(buyer).cancelUnpauseProposal()
      ).to.be.revertedWith("only admin");
    });
  });

  describe("Paused Matrix Hardening", function () {
    it("Should block createTrade while paused", async function () {
      const totalAmount = ethers.parseUnits("107000", 6);
      const logisticsAmount = ethers.parseUnits("5000", 6);
      const platformFeesAmount = ethers.parseUnits("2000", 6);
      const supplierFirstTranche = ethers.parseUnits("40000", 6);
      const supplierSecondTranche = ethers.parseUnits("60000", 6);
      const ricardianHash = ethers.id("paused-create");
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
        deadline
      );

      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWith("paused");
    });

    it("Should block release, confirm, open dispute, and finalize while paused", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("paused-flow"));

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId)
      ).to.be.revertedWith("paused");
      await unpauseWithQuorum();

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(oracle).confirmArrival(tradeId)
      ).to.be.revertedWith("paused");
      await unpauseWithQuorum();

      await escrow.connect(oracle).confirmArrival(tradeId);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(buyer).openDispute(tradeId)
      ).to.be.revertedWith("paused");
      await unpauseWithQuorum();

      await time.increase(24 * 3600 + 1);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(buyer).finalizeAfterDisputeWindow(tradeId)
      ).to.be.revertedWith("paused");
    });

    it("Should block dispute propose/approve while paused", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("paused-dispute"));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(admin1).proposeDisputeSolution(tradeId, 0)
      ).to.be.revertedWith("paused");
      await unpauseWithQuorum();

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await escrow.connect(admin1).pause();
      await expect(
        escrow.connect(admin2).approveDisputeSolution(0)
      ).to.be.revertedWith("paused");
    });

    it("Should allow governance recovery paths while paused", async function () {
      await escrow.connect(admin1).pause();

      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);
      await escrow.connect(admin2).approveOracleUpdate(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, "OracleUpdated");

      await escrow.connect(admin1).proposeAddAdmin(buyer.address);
      await escrow.connect(admin2).approveAddAdmin(0);
      await time.increase(24 * 3600 + 1);
      await expect(escrow.connect(admin1).executeAddAdmin(0))
        .to.emit(escrow, "AdminAdded")
        .withArgs(buyer.address);

      await escrow.connect(admin1).proposeOracleUpdate(oracle.address);
      const governanceTtl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(governanceTtl + 1n);
      await expect(escrow.connect(admin2).cancelExpiredOracleUpdateProposal(1))
        .to.emit(escrow, "OracleUpdateProposalExpiredCancelled")
        .withArgs(1, admin2.address);

      await escrow.connect(admin1).proposeAddAdmin(treasury.address);
      await time.increase(governanceTtl + 1n);
      await expect(escrow.connect(admin2).cancelExpiredAddAdminProposal(1))
        .to.emit(escrow, "AdminAddProposalExpiredCancelled")
        .withArgs(1, admin2.address);

      expect(await escrow.paused()).to.be.true;
    });

    it("Should block LOCK timeout cancel while paused", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("paused-lock-timeout"));
      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(
        escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)
      ).to.be.revertedWith("paused");
    });

    it("Should block IN_TRANSIT timeout refund while paused", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("paused-in-transit-timeout"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(
        escrow.connect(buyer).refundInTransitAfterTimeout(tradeId)
      ).to.be.revertedWith("paused");
    });
  });

  describe("Timeout Escape Hatches", function () {
    it("Should allow buyer to cancel a LOCKED trade after LOCK_TIMEOUT", async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id("lock-timeout"));
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await expect(escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId))
        .to.emit(escrow, "TradeCancelledAfterLockTimeout")
        .withArgs(tradeId, buyer.address, totalAmount);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(totalAmount);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore);
      await claimAndAssert(buyer);
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it("Should allow buyer to refund only remaining principal after IN_TRANSIT timeout", async function () {
      const { tradeId, supplierSecondTranche } = await createDefaultTrade(ethers.id("in-transit-timeout"));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await expect(escrow.connect(buyer).refundInTransitAfterTimeout(tradeId))
        .to.emit(escrow, "InTransitTimeoutRefunded")
        .withArgs(tradeId, buyer.address, supplierSecondTranche);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(supplierSecondTranche);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore);
      await claimAndAssert(buyer);
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });


    it("Should prevent buyer to cancel a LOCKED trade before LOCK_TIMEOUT", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("lock-timeout"));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout - 1n);

      await expect(
        escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)
      ).to.be.revertedWith("lock timeout not elapsed")
    });

    it("Should prevent buyer to refund only remaining principal before IN_TRANSIT timeout", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("in-transit-timeout"));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout - 1n);

      await expect(
        escrow.connect(buyer).refundInTransitAfterTimeout(tradeId)
      ).to.be.revertedWith("in-transit timeout not elapsed");
    });

    it("Should prevent a second LOCK timeout cancellation", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("lock-timeout-double"));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId);

      await expect(
        escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId)
      ).to.be.revertedWith("status must be LOCKED");
    });

    it("Should prevent a second IN_TRANSIT timeout refund", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("in-transit-timeout-double"));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await escrow.connect(buyer).refundInTransitAfterTimeout(tradeId);

      await expect(
        escrow.connect(buyer).refundInTransitAfterTimeout(tradeId)
      ).to.be.revertedWith("status must be IN_TRANSIT");
    });
  });

  describe("Treasury Leakage Guards", function () {
    it("Should keep treasury unchanged on LOCK timeout cancellation", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("treasury-lock-timeout"));
      const treasuryBefore = await usdc.balanceOf(treasury.address);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);
      await escrow.connect(buyer).cancelLockedTradeAfterTimeout(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
    });

    it("Should keep treasury at fees-only after IN_TRANSIT timeout refund", async function () {
      const { tradeId, logisticsAmount, platformFeesAmount } = await createDefaultTrade(
        ethers.id("treasury-in-transit-timeout")
      );
      const treasuryBeforeBalance = await usdc.balanceOf(treasury.address);
      const treasuryBeforeClaimable = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      const expectedTreasuryClaimable = treasuryBeforeClaimable + logisticsAmount + platformFeesAmount;
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeBalance);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(expectedTreasuryClaimable);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);
      await escrow.connect(buyer).refundInTransitAfterTimeout(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeBalance);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(expectedTreasuryClaimable);
    });

    it("Should keep treasury at fees-only after dispute REFUND", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("treasury-dispute-refund"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });

    it("Should keep treasury at fees-only after dispute RESOLVE", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("treasury-dispute-resolve"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 1);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });
  });

  describe("Claim Flow", function () {
    it("Should reject claim when caller has no claimable balance", async function () {
      await expect(escrow.connect(supplier).claim()).to.be.revertedWith("nothing claimable");
    });

    it("Should accrue by recipient and keep claims isolated", async function () {
      const { tradeId, supplierFirstTranche, logisticsAmount, platformFeesAmount } = await createDefaultTrade(
        ethers.id("claim-isolation")
      );

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      expect(await escrow.claimableUsdc(supplier.address)).to.equal(supplierFirstTranche);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(logisticsAmount + platformFeesAmount);
      expect(await escrow.totalClaimableUsdc()).to.equal(
        supplierFirstTranche + logisticsAmount + platformFeesAmount
      );

      await claimAndAssert(supplier);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(logisticsAmount + platformFeesAmount);
      await claimAndAssert(treasury);
      expect(await escrow.totalClaimableUsdc()).to.equal(0);
    });

    it("Should prevent double claim", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("double-claim"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await claimAndAssert(supplier);
      await expect(escrow.connect(supplier).claim()).to.be.revertedWith("nothing claimable");
    });
  });

  describe("createTrade", function () {
    const totalAmount = ethers.parseUnits("107000", 6);
    const logisticsAmount = ethers.parseUnits("5000", 6);
    const platformFeesAmount = ethers.parseUnits("2000", 6);
    const supplierFirstTranche = ethers.parseUnits("40000", 6);
    const supplierSecondTranche = ethers.parseUnits("60000", 6);
    const ricardianHash = ethers.id("trade-contract-hash");

    it("Should create a trade with valid signature", async function () {
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
        deadline
      );

      const tx = await escrow.connect(buyer).createTrade(
        supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
        signature
      );

      await expect(tx)
        .to.emit(escrow, "TradeLocked")
        .withArgs(
          0,
          buyer.address,
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash
        );

      const trade = await escrow.trades(0);
      expect(trade.tradeId).to.equal(0);
      expect(trade.status).to.equal(0); // LOCKED
      expect(trade.buyerAddress).to.equal(buyer.address);
      expect(trade.supplierAddress).to.equal(supplier.address);
      expect(trade.totalAmountLocked).to.equal(totalAmount);
      expect(await escrow.getBuyerNonce(buyer.address)).to.equal(nonce + 1n);
    });

    it("Should create multiple trades with incrementing nonces", async function () {
      const amount = ethers.parseUnits("107000", 6);
      const hash1 = ethers.id("hash1");
      const hash2 = ethers.id("hash2");

      await usdc.connect(buyer).approve(await escrow.getAddress(), amount * 2n);

      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      const nonce0 = await escrow.getBuyerNonce(buyer.address);

      // First trade with nonce 0
      const sig1 = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        amount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, hash1, nonce0, deadline
      );

      await escrow.connect(buyer).createTrade(
        supplier.address, amount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, hash1, nonce0, deadline, sig1
      );

      const nonce1 = await escrow.getBuyerNonce(buyer.address);
      // Second trade with nonce 1
      const sig2 = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        amount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, hash2, nonce1, deadline
      );

      await escrow.connect(buyer).createTrade(
        supplier.address, amount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, hash2, nonce1, deadline, sig2
      );

      expect(await escrow.tradeCounter()).to.equal(2);
      expect(await escrow.getBuyerNonce(buyer.address)).to.equal(2);
    });

    it("Should reject invalid signature (wrong signer)", async function () {
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
        deadline
      );

      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address, totalAmount, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ricardianHash,
          nonce, deadline, signature
        )
      ).to.be.revertedWith("bad signature");
    });

    it("Should reject replay signature", async function () {
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
        deadline
      );

      const tx = await escrow.connect(buyer).createTrade(
        supplier.address,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
        signature
      );

      await expect(tx)
        .to.emit(escrow, "TradeLocked")
        .withArgs(
          0,
          buyer.address,
          supplier.address,
          totalAmount,
          logisticsAmount,
          platformFeesAmount,
          supplierFirstTranche,
          supplierSecondTranche,
          ricardianHash
        );

      // try to create a trade with the same signature
      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address, totalAmount, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ricardianHash,
          nonce, deadline, signature
        )
      ).to.be.revertedWith("bad nonce"); // got rejected because of the nonce
    });


    it("Should reject with invalid parameters (zero addresses, bad hash, mismatched amounts)", async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      await expect(
        escrow.connect(buyer).createTrade(
          ethers.ZeroAddress, totalAmount, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ricardianHash,
          nonce, deadline, "0x00"
        )
      ).to.be.revertedWith("supplier required");

      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address, totalAmount, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ethers.ZeroHash,
          nonce, deadline, "0x00"
        )
      ).to.be.revertedWith("ricardian hash required");

      const wrongTotal = ethers.parseUnits("100000", 6);
      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address, wrongTotal, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ricardianHash,
          nonce, deadline, "0x00"
        )
      ).to.be.revertedWith("breakdown mismatch");
    });

    it("Should reject with bad nonce", async function () {
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const wrongNonce = 5n;

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        totalAmount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, ricardianHash,
        wrongNonce, deadline
      );

      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address, totalAmount, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ricardianHash,
          wrongNonce, deadline, signature
        )
      ).to.be.revertedWith("bad nonce");
    });

    it("Should reject expired signature", async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const expiredDeadline = BigInt(blockTimestamp - 100);

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        totalAmount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, ricardianHash,
        nonce, expiredDeadline
      );

      await expect(
        escrow.connect(buyer).createTrade(
          supplier.address, totalAmount, logisticsAmount, platformFeesAmount,
          supplierFirstTranche, supplierSecondTranche, ricardianHash,
          nonce, expiredDeadline, signature
        )
      ).to.be.revertedWith("signature expired");
    });
  });

  describe("Complete Flow (Without dispute)", function () {
    let tradeId: bigint;
    const totalAmount = ethers.parseUnits("107000", 6);
    const logisticsAmount = ethers.parseUnits("5000", 6);
    const platformFeesAmount = ethers.parseUnits("2000", 6);
    const supplierFirstTranche = ethers.parseUnits("40000", 6);
    const supplierSecondTranche = ethers.parseUnits("60000", 6);

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const ricardianHash = ethers.id("trade-hash");

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        totalAmount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, ricardianHash,
        nonce, deadline
      );

      await escrow.connect(buyer).createTrade(
        supplier.address, totalAmount, logisticsAmount, platformFeesAmount,
        supplierFirstTranche, supplierSecondTranche, ricardianHash,
        nonce, deadline, signature
      );

      tradeId = 0n;
    });

    it("Should complete full trade lifecycle without dispute", async function () {
      const supplierBalBefore = await usdc.balanceOf(supplier.address);
      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      const stage1Tx = await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await expect(stage1Tx).to.emit(escrow, "FundsReleasedStage1");
      await expect(stage1Tx).to.emit(escrow, "PlatformFeesPaidStage1");
      await expect(stage1Tx)
        .to.emit(escrow, "ClaimableAccrued")
        .withArgs(tradeId, supplier.address, supplierFirstTranche, 0);
      await expect(stage1Tx)
        .to.emit(escrow, "ClaimableAccrued")
        .withArgs(tradeId, treasury.address, logisticsAmount, 1);
      await expect(stage1Tx)
        .to.emit(escrow, "ClaimableAccrued")
        .withArgs(tradeId, treasury.address, platformFeesAmount, 2);

      expect(await usdc.balanceOf(supplier.address)).to.equal(supplierBalBefore);
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBalBefore);
      expect(await escrow.claimableUsdc(supplier.address)).to.equal(supplierFirstTranche);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(logisticsAmount + platformFeesAmount);

      let trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(1); // IN_TRANSIT

      await expect(escrow.connect(oracle).confirmArrival(tradeId))
        .to.emit(escrow, "ArrivalConfirmed");

      trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(2); // ARRIVAL_CONFIRMED

      await time.increase(24 * 3600 + 1);

      const supplierBalBeforeStage2 = await usdc.balanceOf(supplier.address);

      await expect(escrow.connect(buyer).finalizeAfterDisputeWindow(tradeId))
        .to.emit(escrow, "FinalTrancheReleased");

      expect(await escrow.claimableUsdc(supplier.address)).to.equal(
        supplierFirstTranche + supplierSecondTranche
      );

      await claimAndAssert(supplier);

      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBalBeforeStage2 + supplierFirstTranche + supplierSecondTranche
      );

      trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });
  });

  describe("releaseFundsStage1", function () {
    let tradeId: bigint;

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const totalAmount = ethers.parseUnits("107000", 6);
      const ricardianHash = ethers.id("trade-hash");

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        totalAmount, ethers.parseUnits("5000", 6), ethers.parseUnits("2000", 6),
        ethers.parseUnits("40000", 6), ethers.parseUnits("60000", 6),
        ricardianHash, nonce, deadline
      );

      await escrow.connect(buyer).createTrade(
        supplier.address, totalAmount, ethers.parseUnits("5000", 6),
        ethers.parseUnits("2000", 6), ethers.parseUnits("40000", 6),
        ethers.parseUnits("60000", 6), ricardianHash, nonce, deadline, signature
      );

      tradeId = 0n;
    });

    it("Should reject if not oracle", async function () {
      await expect(
        escrow.connect(buyer).releaseFundsStage1(tradeId)
      ).to.be.revertedWith("only oracle");
    });

    it("Should reject if wrong status", async function () {
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      await expect(
        escrow.connect(oracle).releaseFundsStage1(tradeId)
      ).to.be.revertedWith("status must be LOCKED");
    });
  });

  describe("confirmArrival", function () {
    let tradeId: bigint;

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const totalAmount = ethers.parseUnits("107000", 6);
      const ricardianHash = ethers.id("trade-hash");

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        totalAmount, ethers.parseUnits("5000", 6), ethers.parseUnits("2000", 6),
        ethers.parseUnits("40000", 6), ethers.parseUnits("60000", 6),
        ricardianHash, nonce, deadline
      );

      await escrow.connect(buyer).createTrade(
        supplier.address, totalAmount, ethers.parseUnits("5000", 6),
        ethers.parseUnits("2000", 6), ethers.parseUnits("40000", 6),
        ethers.parseUnits("60000", 6), ricardianHash, nonce, deadline, signature
      );

      tradeId = 0n;
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
    });

    it("Should confirm arrival", async function () {
      await expect(escrow.connect(oracle).confirmArrival(tradeId))
        .to.emit(escrow, "ArrivalConfirmed");

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(2); // ARRIVAL_CONFIRMED
      expect(trade.arrivalTimestamp).to.be.gt(0);
    });

    it("Should reject if not oracle", async function () {
      await expect(
        escrow.connect(buyer).confirmArrival(tradeId)
      ).to.be.revertedWith("only oracle");
    });

    it("Should reject if wrong status", async function () {
      await escrow.connect(oracle).confirmArrival(tradeId);

      await expect(
        escrow.connect(oracle).confirmArrival(tradeId)
      ).to.be.revertedWith("status must be IN_TRANSIT");
    });
  });

  describe("Dispute Flow", function () {
    let tradeId: bigint;
    const supplierSecondTranche = ethers.parseUnits("60000", 6);
    const supplierFirstTranche = ethers.parseUnits("40000", 6);
    const logistics = ethers.parseUnits("5000", 6);
    const fees = ethers.parseUnits("2000", 6);
    const totalAmount = ethers.parseUnits("107000", 6);

    beforeEach(async function () {
      const nonce = await escrow.getBuyerNonce(buyer.address);
      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);
      const ricardianHash = ethers.id("trade-hash");

      await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);

      const signature = await createSignature(
        buyer, await escrow.getAddress(), buyer.address, supplier.address,
        totalAmount,logistics, fees,
        supplierFirstTranche, supplierSecondTranche,
        ricardianHash, nonce, deadline
      );

      await escrow.connect(buyer).createTrade(
        supplier.address, totalAmount, logistics,
        fees, supplierFirstTranche,
        supplierSecondTranche, ricardianHash, nonce, deadline, signature
      );

      tradeId = 0n;
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
    });

    it("Should allow buyer to open dispute within 24h", async function () {
      await expect(escrow.connect(buyer).openDispute(tradeId))
        .to.emit(escrow, "DisputeOpenedByBuyer");

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(3); // FROZEN
    });

    it("Should reject dispute after 24h window", async function () {
      await time.increase(24 * 3600 + 1);

      await expect(
        escrow.connect(buyer).openDispute(tradeId)
      ).to.be.revertedWith("window closed");
    });

    it("Should reject dispute from non-buyer", async function () {
      await expect(
        escrow.connect(supplier).openDispute(tradeId)
      ).to.be.revertedWith("only buyer");
    });

    it("Should refund buyer after dispute REFUND resolution", async function () {
      await escrow.connect(buyer).openDispute(tradeId);

      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      // propose REFUND
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0); // REFUND

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, "DisputePayout")
        .withArgs(tradeId, 0, buyer.address, supplierSecondTranche, 0);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(supplierSecondTranche);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore);
      await claimAndAssert(buyer);

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it("Should pay supplier after dispute RESOLVE resolution", async function () {
      await escrow.connect(buyer).openDispute(tradeId);

      const supplierBalBefore = await usdc.balanceOf(supplier.address);

      // propose RESOLVE
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 1); // RESOLVE

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, "DisputePayout")
        .withArgs(tradeId, 0, supplier.address, supplierSecondTranche, 1);

      expect(await escrow.claimableUsdc(supplier.address)).to.equal(
        supplierFirstTranche + supplierSecondTranche
      );
      await claimAndAssert(supplier);
      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBalBefore + supplierFirstTranche + supplierSecondTranche
      );

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it("Should reject dispute proposal from non-admin", async function () {
      await escrow.connect(buyer).openDispute(tradeId);

      await expect(
        escrow.connect(buyer).proposeDisputeSolution(tradeId, 0)
      ).to.be.revertedWith("only admin");
    });

    it("Should reject dispute approval from non-admin", async function () {
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await expect(
        escrow.connect(buyer).approveDisputeSolution(0)
      ).to.be.revertedWith("only admin");
    });

    it("Should enforce dispute proposal expiry and allow manual cancellation", async function () {
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(
        escrow.connect(admin2).approveDisputeSolution(0)
      ).to.be.revertedWith("proposal expired");

      await expect(escrow.connect(admin2).cancelExpiredDisputeProposal(0))
        .to.emit(escrow, "DisputeProposalExpiredCancelled")
        .withArgs(0, tradeId, admin2.address);

      await expect(escrow.connect(admin2).proposeDisputeSolution(tradeId, 1))
        .to.emit(escrow, "DisputeSolutionProposed")
        .withArgs(1, tradeId, 1, admin2.address);
    });

    it("Should auto-cancel expired active proposal when replacing with a new one", async function () {
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(escrow.connect(admin2).proposeDisputeSolution(tradeId, 1))
        .to.emit(escrow, "DisputeProposalExpiredCancelled")
        .withArgs(0, tradeId, admin2.address)
        .and.to.emit(escrow, "DisputeSolutionProposed")
        .withArgs(1, tradeId, 1, admin2.address);
    });
  });

  describe("Governance: Oracle Update", function () {
    it("Should update oracle with timelock", async function () {
      const newOracle = admin3.address;

      await escrow.connect(admin1).proposeOracleUpdate(newOracle);

      await escrow.connect(admin2).approveOracleUpdate(0);

      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, "OracleUpdated")
        .withArgs(oracle.address, newOracle);

      expect(await escrow.oracleAddress()).to.equal(newOracle);
    });

    it("Should reject execution before timelock", async function () {
      const newOracle = admin3.address;

      await escrow.connect(admin1).proposeOracleUpdate(newOracle);
      await escrow.connect(admin2).approveOracleUpdate(0);

      await expect(
        escrow.connect(admin1).executeOracleUpdate(0)
      ).to.be.revertedWith("timelock not elapsed");
    });

    it("Should reject oracle update from non-admin", async function () {
      await expect(
        escrow.connect(buyer).proposeOracleUpdate(admin3.address)
      ).to.be.revertedWith("only admin");
    });

    it("Should reject execution after proposal expiry and allow cancel", async function () {
      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(
        escrow.connect(admin1).executeOracleUpdate(0)
      ).to.be.revertedWith("proposal expired");

      await expect(escrow.connect(admin2).cancelExpiredOracleUpdateProposal(0))
        .to.emit(escrow, "OracleUpdateProposalExpiredCancelled")
        .withArgs(0, admin2.address);

      await expect(
        escrow.connect(admin1).executeOracleUpdate(0)
      ).to.be.revertedWith("proposal cancelled");
    });
  });

  describe("Governance: Add Admin", function () {
    it("Should add new admin with timelock", async function () {
      const newAdmin = buyer.address;

      await escrow.connect(admin1).proposeAddAdmin(newAdmin);

      await escrow.connect(admin2).approveAddAdmin(0);

      await time.increase(24 * 3600 + 1);

      await expect(escrow.connect(admin1).executeAddAdmin(0))
        .to.emit(escrow, "AdminAdded")
        .withArgs(newAdmin);

      expect(await escrow.isAdmin(newAdmin)).to.be.true;
    });

    it("Should reject add admin from non-admin", async function () {
      await expect(
        escrow.connect(buyer).proposeAddAdmin(buyer.address)
      ).to.be.revertedWith("only admin");
    });

    it("Should reject execution after proposal expiry and allow cancel", async function () {
      await escrow.connect(admin1).proposeAddAdmin(buyer.address);

      const ttl = await escrow.GOVERNANCE_PROPOSAL_TTL();
      await time.increase(ttl + 1n);

      await expect(
        escrow.connect(admin1).executeAddAdmin(0)
      ).to.be.revertedWith("proposal expired");

      await expect(escrow.connect(admin2).cancelExpiredAddAdminProposal(0))
        .to.emit(escrow, "AdminAddProposalExpiredCancelled")
        .withArgs(0, admin2.address);

      await expect(
        escrow.connect(admin1).executeAddAdmin(0)
      ).to.be.revertedWith("proposal cancelled");
    });
  });

  describe("Expiry Edge Boundaries", function () {
    it("Should allow dispute approval exactly at dispute TTL boundary", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("dispute-expiry-boundary-ok"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const proposal = await escrow.disputeProposals(0);
      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.setNextBlockTimestamp(proposal.createdAt + ttl);

      await expect(escrow.connect(admin2).approveDisputeSolution(0))
        .to.emit(escrow, "DisputeFinalized")
        .withArgs(0, tradeId, 0);
    });

    it("Should reject dispute approval one second after dispute TTL boundary", async function () {
      const { tradeId } = await createDefaultTrade(ethers.id("dispute-expiry-boundary-fail"));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await escrow.connect(buyer).openDispute(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      const proposal = await escrow.disputeProposals(0);
      const ttl = await escrow.DISPUTE_PROPOSAL_TTL();
      await time.setNextBlockTimestamp(proposal.createdAt + ttl + 1n);

      await expect(
        escrow.connect(admin2).approveDisputeSolution(0)
      ).to.be.revertedWith("proposal expired");
    });

    it("Should allow oracle governance execution exactly at governance TTL boundary", async function () {
      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);
      await escrow.connect(admin2).approveOracleUpdate(0);

      const expiresAt = await escrow.oracleUpdateProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt);

      await expect(escrow.connect(admin1).executeOracleUpdate(0))
        .to.emit(escrow, "OracleUpdated")
        .withArgs(oracle.address, admin3.address);
    });

    it("Should reject oracle governance execution one second after governance TTL boundary", async function () {
      await escrow.connect(admin1).proposeOracleUpdate(admin3.address);
      await escrow.connect(admin2).approveOracleUpdate(0);

      const expiresAt = await escrow.oracleUpdateProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt + 1n);

      await expect(
        escrow.connect(admin1).executeOracleUpdate(0)
      ).to.be.revertedWith("proposal expired");
    });

    it("Should allow add-admin governance execution exactly at governance TTL boundary", async function () {
      await escrow.connect(admin1).proposeAddAdmin(buyer.address);
      await escrow.connect(admin2).approveAddAdmin(0);

      const expiresAt = await escrow.adminAddProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt);

      await expect(escrow.connect(admin1).executeAddAdmin(0))
        .to.emit(escrow, "AdminAdded")
        .withArgs(buyer.address);
    });

    it("Should reject add-admin governance execution one second after governance TTL boundary", async function () {
      await escrow.connect(admin1).proposeAddAdmin(buyer.address);
      await escrow.connect(admin2).approveAddAdmin(0);

      const expiresAt = await escrow.adminAddProposalExpiresAt(0);
      await time.setNextBlockTimestamp(expiresAt + 1n);

      await expect(
        escrow.connect(admin1).executeAddAdmin(0)
      ).to.be.revertedWith("proposal expired");
    });
  });
});

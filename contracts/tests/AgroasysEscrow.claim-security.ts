/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  AgroasysEscrow,
  ClaimHookReceiver,
  HookedMockUSDC,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgroasysEscrow - Claim Security", function () {
  let escrow: AgroasysEscrow;
  let usdc: HookedMockUSDC;
  let receiver: ClaimHookReceiver;
  let buyer: SignerWithAddress;
  let treasury: SignerWithAddress;
  let oracle: SignerWithAddress;
  let admin1: SignerWithAddress;
  let admin2: SignerWithAddress;
  let admin3: SignerWithAddress;

  const logisticsAmount = ethers.parseUnits("5000", 6);
  const platformFeesAmount = ethers.parseUnits("2000", 6);
  const supplierFirstTranche = ethers.parseUnits("40000", 6);
  const supplierSecondTranche = ethers.parseUnits("60000", 6);
  const totalAmount = logisticsAmount + platformFeesAmount + supplierFirstTranche + supplierSecondTranche;

  async function createSignature(
    signer: SignerWithAddress,
    contractAddr: string,
    buyerAddr: string,
    supplierAddr: string,
    ricardianHash: string,
    nonce: bigint,
    deadline: bigint
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
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
        treasury.address,
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
    return signer.signMessage(ethers.getBytes(messageHash));
  }

  async function createTradeToReceiver(ricardianHash: string) {
    const nonce = await escrow.getBuyerNonce(buyer.address);
    const blockTimestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
    const deadline = BigInt(blockTimestamp + 3600);

    await usdc.connect(buyer).approve(await escrow.getAddress(), totalAmount);
    const signature = await createSignature(
      buyer,
      await escrow.getAddress(),
      buyer.address,
      await receiver.getAddress(),
      ricardianHash,
      nonce,
      deadline
    );

    await escrow.connect(buyer).createTrade(
      await receiver.getAddress(),
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
  }

  beforeEach(async function () {
    [buyer, treasury, oracle, admin1, admin2, admin3] = await ethers.getSigners();

    const HookedUSDCFactory = await ethers.getContractFactory("HookedMockUSDC");
    usdc = await HookedUSDCFactory.deploy();
    await usdc.waitForDeployment();

    const EscrowFactory = await ethers.getContractFactory("AgroasysEscrow");
    escrow = await EscrowFactory.deploy(
      await usdc.getAddress(),
      oracle.address,
      treasury.address,
      [admin1.address, admin2.address, admin3.address],
      2
    );
    await escrow.waitForDeployment();

    const ReceiverFactory = await ethers.getContractFactory("ClaimHookReceiver");
    receiver = await ReceiverFactory.deploy(await escrow.getAddress());
    await receiver.waitForDeployment();

    await usdc.mint(buyer.address, ethers.parseUnits("1000000", 6));
  });

  it("blocks reentrant claim attempts from malicious receiver hooks", async function () {
    await createTradeToReceiver(ethers.id("claim-reentrancy"));
    await escrow.connect(oracle).releaseFundsStage1(0);

    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(supplierFirstTranche);

    await usdc.setHookEnabled(await receiver.getAddress(), true);
    await receiver.configure(true, false);

    const receiverBalanceBefore = await usdc.balanceOf(await receiver.getAddress());
    await receiver.triggerClaim();

    expect(await receiver.reentryAttempted()).to.equal(true);
    const lastError = await receiver.lastError();
    expect(lastError).to.not.equal("0x");

    const selector = lastError.slice(0, 10);
    const reentrancySelector = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);

    if (selector === "0x08c379a0") {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${lastError.slice(10)}`);
      expect(decoded[0]).to.equal("nothing claimable");
    } else {
      expect(selector).to.equal(reentrancySelector);
    }

    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(0);
    expect(await usdc.balanceOf(await receiver.getAddress())).to.equal(receiverBalanceBefore + supplierFirstTranche);
  });

  it("isolates failed claims so other recipients can still claim", async function () {
    await createTradeToReceiver(ethers.id("claim-failure-isolation"));
    await escrow.connect(oracle).releaseFundsStage1(0);

    const treasuryClaimable = logisticsAmount + platformFeesAmount;
    expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryClaimable);

    await usdc.setHookEnabled(await receiver.getAddress(), true);
    await receiver.configure(false, true);

    await expect(receiver.triggerClaim()).to.be.revertedWith("hook revert");
    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(supplierFirstTranche);

    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await expect(escrow.connect(treasury).claim())
      .to.emit(escrow, "Claimed")
      .withArgs(treasury.address, treasuryClaimable);
    expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + treasuryClaimable);

    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(supplierFirstTranche);
  });
});

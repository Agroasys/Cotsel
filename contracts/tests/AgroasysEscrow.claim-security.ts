/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { AgroasysEscrow, ClaimHookReceiver, HookedMockUSDC } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('AgroasysEscrow - Claim Security', function () {
  let escrow: AgroasysEscrow;
  let usdc: HookedMockUSDC;
  let receiver: ClaimHookReceiver;
  let buyer: SignerWithAddress;
  let treasury: SignerWithAddress;
  let oracle: SignerWithAddress;
  let relayer: SignerWithAddress;
  let admin1: SignerWithAddress;
  let admin2: SignerWithAddress;
  let admin3: SignerWithAddress;

  const logisticsAmount = ethers.parseUnits('5000', 6);
  const platformFeesAmount = ethers.parseUnits('1504', 6);
  const supplierFirstTranche = ethers.parseUnits('59500', 6);
  const supplierSecondTranche = ethers.parseUnits('40000', 6);
  const totalAmount =
    logisticsAmount + platformFeesAmount + supplierFirstTranche + supplierSecondTranche;

  async function signCreateTradeAuthorization(
    signer: SignerWithAddress,
    params: {
      buyer: string;
      supplier: string;
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
      {
        buyer: params.buyer,
        supplier: params.supplier,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash: params.ricardianHash,
        nonce: params.nonce,
        deadline: params.deadline,
      },
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

  async function createTradeToReceiver(ricardianHash: string) {
    const nonce = await escrow.authorizationNonces(buyer.address);
    const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
    const deadline = BigInt(blockTimestamp + 3600);
    const escrowAddress = await escrow.getAddress();
    const receiverAddress = await receiver.getAddress();
    const usdcNonce = ethers.id(`claim-security-${ricardianHash}`);

    const signature = await signCreateTradeAuthorization(buyer, {
      buyer: buyer.address,
      supplier: receiverAddress,
      ricardianHash,
      nonce,
      deadline,
    });
    const usdcSignature = await signUsdcReceiveAuthorization(buyer, {
      from: buyer.address,
      to: escrowAddress,
      value: totalAmount,
      validAfter: 0n,
      validBefore: deadline,
      nonce: usdcNonce,
    });

    await escrow
      .connect(admin1)
      .createTradeWithAuthorization(
        buyer.address,
        receiverAddress,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce,
        deadline,
        signature,
        {
          validAfter: 0n,
          validBefore: deadline,
          nonce: usdcNonce,
          v: usdcSignature.v,
          r: usdcSignature.r,
          s: usdcSignature.s,
        },
      );
  }

  beforeEach(async function () {
    [buyer, treasury, oracle, relayer, admin1, admin2, admin3] = await ethers.getSigners();

    const HookedUSDCFactory = await ethers.getContractFactory('HookedMockUSDC');
    usdc = await HookedUSDCFactory.deploy();
    await usdc.waitForDeployment();

    const EscrowFactory = await ethers.getContractFactory('AgroasysEscrow');
    escrow = await EscrowFactory.deploy(
      await usdc.getAddress(),
      oracle.address,
      treasury.address,
      relayer.address,
      [admin1.address, admin2.address, admin3.address],
      2,
    );
    await escrow.waitForDeployment();

    const ReceiverFactory = await ethers.getContractFactory('ClaimHookReceiver');
    receiver = await ReceiverFactory.deploy(await escrow.getAddress());
    await receiver.waitForDeployment();

    await usdc.mint(buyer.address, ethers.parseUnits('1000000', 6));
  });

  it('blocks supplier payout hook reentrancy from creating claim-side effects', async function () {
    await createTradeToReceiver(ethers.id('claim-reentrancy'));
    await usdc.setHookEnabled(await receiver.getAddress(), true);
    await receiver.configure(true, false);

    const receiverBalanceBefore = await usdc.balanceOf(await receiver.getAddress());
    await escrow.connect(oracle).releaseFundsStage1(0);

    expect(await receiver.reentryAttempted()).to.equal(true);
    const lastError = await receiver.lastError();
    expect(lastError).to.not.equal('0x');

    const selector = lastError.slice(0, 10);
    const reentrancySelector = ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10);

    if (selector === '0x08c379a0') {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['string'],
        `0x${lastError.slice(10)}`,
      );
      expect(decoded[0]).to.equal('only treasury or admin');
    } else {
      expect(selector).to.equal(reentrancySelector);
    }

    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(0);
    expect(await usdc.balanceOf(await receiver.getAddress())).to.equal(
      receiverBalanceBefore + supplierFirstTranche,
    );
  });

  it('reverts failed direct supplier payout without accruing partial treasury claims', async function () {
    await createTradeToReceiver(ethers.id('claim-failure-isolation'));

    await usdc.setHookEnabled(await receiver.getAddress(), true);
    await receiver.configure(false, true);

    await expect(escrow.connect(oracle).releaseFundsStage1(0)).to.be.revertedWith('hook revert');
    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(0);
    expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);

    const trade = await escrow.trades(0);
    expect(trade.status).to.equal(0);

    await receiver.configure(false, false);
    await escrow.connect(oracle).releaseFundsStage1(0);

    const treasuryClaimable = logisticsAmount + platformFeesAmount;
    expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryClaimable);

    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await expect(escrow.connect(treasury).claimTreasury())
      .to.emit(escrow, 'TreasuryClaimed')
      .withArgs(treasury.address, treasury.address, treasuryClaimable, treasury.address);
    expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + treasuryClaimable);

    expect(await escrow.claimableUsdc(await receiver.getAddress())).to.equal(0);
  });

  it('isolates failed treasury sweep so other claim paths remain usable', async function () {
    await createTradeToReceiver(ethers.id('treasury-sweep-failure-isolation'));
    await escrow.connect(oracle).releaseFundsStage1(0);

    const treasuryClaimable = logisticsAmount + platformFeesAmount;
    expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryClaimable);

    await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(await receiver.getAddress());
    await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(0);

    const timelock = await escrow.governanceTimelock();
    await ethers.provider.send('evm_increaseTime', [Number(timelock) + 1]);
    await ethers.provider.send('evm_mine', []);
    await escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(0);

    await usdc.setHookEnabled(await receiver.getAddress(), true);
    await receiver.configure(false, true);

    await expect(escrow.connect(treasury).claimTreasury()).to.be.revertedWith('hook revert');
    expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryClaimable);

    // once the hook is resolved, claimTreasury routes to the rotated receiver — state was not corrupted
    await usdc.setHookEnabled(await receiver.getAddress(), false);
    const receiverBefore = await usdc.balanceOf(await receiver.getAddress());
    const treasuryWalletBefore = await usdc.balanceOf(treasury.address);
    await expect(escrow.connect(treasury).claimTreasury())
      .to.emit(escrow, 'TreasuryClaimed')
      .withArgs(treasury.address, await receiver.getAddress(), treasuryClaimable, treasury.address);
    expect(await usdc.balanceOf(await receiver.getAddress())).to.equal(
      receiverBefore + treasuryClaimable,
    );
    expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryWalletBefore);
  });
});

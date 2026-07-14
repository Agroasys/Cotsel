/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect } from 'chai';
import { artifacts, ethers } from 'hardhat';
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
  let relayer: SignerWithAddress;
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
    domainOverrides: Partial<{ chainId: bigint; verifyingContract: string }> = {},
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer.signTypedData(
      {
        name: 'AgroasysEscrow',
        version: '1',
        chainId: domainOverrides.chainId ?? chainId,
        verifyingContract: domainOverrides.verifyingContract ?? (await escrow.getAddress()),
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
    domainOverrides: Partial<{ chainId: bigint; verifyingContract: string }> = {},
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer.signTypedData(
      {
        name: 'AgroasysEscrow',
        version: '1',
        chainId: domainOverrides.chainId ?? chainId,
        verifyingContract: domainOverrides.verifyingContract ?? (await escrow.getAddress()),
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

  async function createTradeWithAuthorizationForTest(
    supplierAddress: string,
    totalAmount: bigint,
    logisticsAmount: bigint,
    platformFeesAmount: bigint,
    supplierFirstTranche: bigint,
    supplierSecondTranche: bigint,
    ricardianHash: string,
    _legacyNonce?: bigint,
    authorizationDeadline?: bigint,
    _legacySignature?: string,
    buyerSigner: SignerWithAddress = buyer,
    relayerSigner: SignerWithAddress = admin1,
  ) {
    const buyerAddress = buyerSigner.address;
    const escrowAddress = await escrow.getAddress();
    const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
    const deadline = authorizationDeadline ?? BigInt(blockTimestamp + 3600);
    const authorizationNonce = _legacyNonce ?? (await escrow.authorizationNonces(buyerAddress));

    const authorizationSignature =
      _legacySignature ??
      (await signCreateTradeAuthorization(buyerSigner, {
        buyer: buyerAddress,
        supplier: supplierAddress,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        nonce: authorizationNonce,
        deadline,
      }));

    const usdcNonce = ethers.id(
      `usdc-${buyerAddress}-${authorizationNonce.toString()}-${ricardianHash}`,
    );
    const usdcSignature = await signUsdcReceiveAuthorization(buyerSigner, {
      from: buyerAddress,
      to: escrowAddress,
      value: totalAmount,
      validAfter: 0n,
      validBefore: deadline,
      nonce: usdcNonce,
    });

    return escrow
      .connect(relayerSigner)
      .createTradeWithAuthorization(
        buyerAddress,
        supplierAddress,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash,
        authorizationNonce,
        deadline,
        authorizationSignature,
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

  async function executeUserActionWithAuthorization(
    tradeId: bigint,
    action: number,
    signer: SignerWithAddress,
    method:
      | 'openDisputeWithAuthorization'
      | 'cancelLockedTradeAfterTimeoutWithAuthorization'
      | 'refundInTransitAfterTimeoutWithAuthorization'
      | 'finalizeAfterDisputeWindowWithAuthorization',
    relayerSigner: SignerWithAddress = admin1,
  ) {
    const nonce = await escrow.authorizationNonces(signer.address);
    const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
    const deadline = BigInt(blockTimestamp + 3600);
    const signature = await signUserActionAuthorization(signer, {
      user: signer.address,
      action,
      tradeId,
      nonce,
      deadline,
    });

    return escrow.connect(relayerSigner)[method](tradeId, nonce, deadline, signature);
  }

  async function openDisputeAsBuyer(tradeId: bigint) {
    return executeUserActionWithAuthorization(tradeId, 1, buyer, 'openDisputeWithAuthorization');
  }

  async function cancelLockedTradeAfterTimeoutAsBuyer(tradeId: bigint) {
    return executeUserActionWithAuthorization(
      tradeId,
      2,
      buyer,
      'cancelLockedTradeAfterTimeoutWithAuthorization',
    );
  }

  async function refundInTransitAfterTimeoutAsBuyer(tradeId: bigint) {
    return executeUserActionWithAuthorization(
      tradeId,
      3,
      buyer,
      'refundInTransitAfterTimeoutWithAuthorization',
    );
  }

  async function finalizeAfterDisputeWindowAsSupplier(tradeId: bigint) {
    return executeUserActionWithAuthorization(
      tradeId,
      4,
      supplier,
      'finalizeAfterDisputeWindowWithAuthorization',
    );
  }

  async function createDefaultTrade(ricardianHash: string = ethers.id('trade-hash')) {
    const totalAmount = ethers.parseUnits('106004', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('1504', 6);
    const supplierFirstTranche = ethers.parseUnits('59500', 6);
    const supplierSecondTranche = ethers.parseUnits('40000', 6);

    const nonce = await escrow.getAuthorizationNonce(buyer.address);
    const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
    const deadline = BigInt(blockTimestamp + 3600);

    await createTradeWithAuthorizationForTest(
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
    [buyer, supplier, treasury, oracle, relayer, admin1, admin2, admin3] =
      await ethers.getSigners();

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
      relayer.address,
      admins,
      2,
    );
    await escrow.waitForDeployment();
  });

  describe('Deployment', function () {
    it('Keeps deployed bytecode within the EVM contract-size limit', async function () {
      const artifact = await artifacts.readArtifact('AgroasysEscrow');
      const deployedBytecodeBytes = (artifact.deployedBytecode.length - 2) / 2;

      expect(deployedBytecodeBytes).to.be.at.most(24_576);
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
      ).to.be.revertedWith('invalid token');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          treasury.address,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('invalid oracle');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          ethers.ZeroAddress,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('invalid treasury');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          ethers.ZeroAddress,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('invalid relayer');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address],
          0,
        ),
      ).to.be.revertedWith('required approvals must be >= 2');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
          [admin1.address],
          1,
        ),
      ).to.be.revertedWith('required approvals must be >= 2');

      await expect(
        EscrowFactory.deploy(
          await usdc.getAddress(),
          oracle.address,
          treasury.address,
          relayer.address,
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
        relayer.address,
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
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id('pause-refund-flow'));
      const buyerBalBefore = await usdc.balanceOf(buyer.address);
      await time.increase(7 * 24 * 3600 + 1);
      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId))
        .to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, totalAmount, 4, admin1.address);

      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + totalAmount);
      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);

      await escrow.connect(admin1).pause();
    });

    it('Should keep buyer refunds automatic even when treasury claims are paused', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(
        ethers.id('claims-paused-buyer-refund'),
      );
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      await expect(escrow.connect(admin1).pauseClaims())
        .to.emit(escrow, 'ClaimsPaused')
        .withArgs(admin1.address);
      expect(await escrow.claimsPaused()).to.equal(true);

      await time.increase(7 * 24 * 3600 + 1);
      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + totalAmount);
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
      const totalAmount = ethers.parseUnits('106004', 6);
      const logisticsAmount = ethers.parseUnits('5000', 6);
      const platformFeesAmount = ethers.parseUnits('1504', 6);
      const supplierFirstTranche = ethers.parseUnits('59500', 6);
      const supplierSecondTranche = ethers.parseUnits('40000', 6);
      const ricardianHash = ethers.id('paused-create');
      const nonce = await escrow.authorizationNonces(buyer.address);
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
      await expect(openDisputeAsBuyer(tradeId)).to.be.revertedWith('paused');
      await unpauseWithQuorum();

      await time.increase(24 * 3600 + 1);

      await escrow.connect(admin1).pause();
      await expect(finalizeAfterDisputeWindowAsSupplier(tradeId)).to.be.revertedWith('paused');
    });

    it('Should block dispute propose/approve while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-dispute'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await openDisputeAsBuyer(tradeId);

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

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith('paused');
    });

    it('Should block IN_TRANSIT timeout refund while paused', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('paused-in-transit-timeout'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await escrow.connect(admin1).pause();

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith('paused');
    });
  });

  describe('Timeout Escape Hatches', function () {
    it('Should allow buyer to cancel a LOCKED trade after LOCK_TIMEOUT', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id('lock-timeout'));
      const buyerBalBefore = await usdc.balanceOf(buyer.address);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId))
        .to.emit(escrow, 'TradeCancelledAfterLockTimeout')
        .withArgs(tradeId, buyer.address, totalAmount)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, totalAmount, 4, admin1.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + totalAmount);
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

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId))
        .to.emit(escrow, 'InTransitTimeoutRefunded')
        .withArgs(tradeId, buyer.address, supplierSecondTranche)
        .and.to.emit(escrow, 'BuyerRefundTransferred')
        .withArgs(tradeId, buyer.address, supplierSecondTranche, 5, admin1.address);

      expect(await escrow.claimableUsdc(buyer.address)).to.equal(0);
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBalBefore + supplierSecondTranche);
      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4); // CLOSED
    });

    it('Should prevent buyer to cancel a LOCKED trade before LOCK_TIMEOUT', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('lock-timeout'));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout - 1n);

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith(
        'lock timeout not elapsed',
      );
    });

    it('Should prevent buyer to refund only remaining principal before IN_TRANSIT timeout', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('in-transit-timeout'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout - 1n);

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith(
        'in-transit timeout not elapsed',
      );
    });

    it('Should prevent a second LOCK timeout cancellation', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('lock-timeout-double'));

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);

      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);

      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith(
        'status must be LOCKED',
      );
    });

    it('Should prevent a second IN_TRANSIT timeout refund', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('in-transit-timeout-double'));

      await escrow.connect(oracle).releaseFundsStage1(tradeId);

      const inTransitTimeout = await escrow.IN_TRANSIT_TIMEOUT();
      await time.increase(inTransitTimeout + 1n);

      await refundInTransitAfterTimeoutAsBuyer(tradeId);

      await expect(refundInTransitAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith(
        'status must be IN_TRANSIT',
      );
    });
  });

  describe('Treasury Leakage Guards', function () {
    it('Should refund every protected component when Stage 1 never occurs', async function () {
      const { tradeId, totalAmount } = await createDefaultTrade(ethers.id('treasury-lock-timeout'));
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      expect(await escrow.nonRefundableFeeAmount(tradeId)).to.equal(0);
      expect(await escrow.buyerRefundableAmount(tradeId)).to.equal(totalAmount);

      const lockTimeout = await escrow.LOCK_TIMEOUT();
      await time.increase(lockTimeout + 1n);
      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(0);
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
      await refundInTransitAfterTimeoutAsBuyer(tradeId);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeBalance);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(expectedTreasuryClaimable);
    });

    it('Should keep treasury at fees-only after dispute REFUND', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-dispute-refund'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await openDisputeAsBuyer(tradeId);

      const treasuryAfterStage1 = await escrow.claimableUsdc(treasury.address);

      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);
      await escrow.connect(admin2).approveDisputeSolution(0);

      expect(await escrow.claimableUsdc(treasury.address)).to.equal(treasuryAfterStage1);
    });

    it('Should keep treasury at fees-only after dispute RESOLVE', async function () {
      const { tradeId } = await createDefaultTrade(ethers.id('treasury-dispute-resolve'));
      await escrow.connect(oracle).releaseFundsStage1(tradeId);
      await escrow.connect(oracle).confirmArrival(tradeId);
      await openDisputeAsBuyer(tradeId);

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
      await cancelLockedTradeAfterTimeoutAsBuyer(tradeId);
      const buyerAfterRefund = await usdc.balanceOf(buyer.address);

      expect(buyerAfterRefund).to.be.gt(buyerBefore);
      await expect(cancelLockedTradeAfterTimeoutAsBuyer(tradeId)).to.be.revertedWith(
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

  describe('createTradeWithAuthorization', function () {
    const totalAmount = ethers.parseUnits('106004', 6);
    const logisticsAmount = ethers.parseUnits('5000', 6);
    const platformFeesAmount = ethers.parseUnits('1504', 6);
    const supplierFirstTranche = ethers.parseUnits('59500', 6);
    const supplierSecondTranche = ethers.parseUnits('40000', 6);
    const ricardianHash = ethers.id('trade-contract-hash');

    it('Should create a trade with valid signature', async function () {
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

      const trade = await escrow.trades(0);
      expect(trade.tradeId).to.equal(0);
      expect(trade.status).to.equal(0); // LOCKED
      expect(trade.buyerAddress).to.equal(buyer.address);
      expect(trade.supplierAddress).to.equal(supplier.address);
      expect(trade.totalAmountLocked).to.equal(totalAmount);
      expect(await escrow.authorizationNonces(buyer.address)).to.equal(nonce + 1n);
    });

    it('Should preserve the launch 60/40 and fee accounting invariant on-chain', async function () {
      const goodsAmount = ethers.parseUnits('1000', 6);
      const buyerPlatformFee = ethers.parseUnits('10', 6);
      const settlementSupportFee = ethers.parseUnits('4', 6);
      const supplierPlatformFee = ethers.parseUnits('5', 6);
      const orderLogisticsFee = ethers.parseUnits('50', 6);
      const firstSupplierNet = ethers.parseUnits('595', 6);
      const finalSupplierTranche = ethers.parseUnits('400', 6);
      const combinedPlatformFees = buyerPlatformFee + settlementSupportFee + supplierPlatformFee;
      const buyerCharge = goodsAmount + orderLogisticsFee + buyerPlatformFee + settlementSupportFee;

      await createTradeWithAuthorizationForTest(
        supplier.address,
        buyerCharge,
        orderLogisticsFee,
        combinedPlatformFees,
        firstSupplierNet,
        finalSupplierTranche,
        ethers.id('launch-accounting-invariant'),
      );

      const trade = await escrow.trades(0);
      expect(trade.totalAmountLocked).to.equal(buyerCharge);
      expect(trade.supplierFirstTranche).to.equal(firstSupplierNet);
      expect(trade.supplierSecondTranche).to.equal(finalSupplierTranche);
      expect(await escrow.nonRefundableFeeAmount(0)).to.equal(0);

      const supplierBefore = await usdc.balanceOf(supplier.address);
      await escrow.connect(oracle).releaseFundsStage1(0);

      expect(await usdc.balanceOf(supplier.address)).to.equal(supplierBefore + firstSupplierNet);
      expect(await escrow.claimableUsdc(treasury.address)).to.equal(
        orderLogisticsFee + combinedPlatformFees,
      );
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(
        finalSupplierTranche + orderLogisticsFee + combinedPlatformFees,
      );
    });

    it('Should reject non-launch tranche or fee proportions on the strict entry point', async function () {
      await expect(
        createTradeWithAuthorizationForTest(
          supplier.address,
          ethers.parseUnits('1064', 6),
          ethers.parseUnits('50', 6),
          ethers.parseUnits('19', 6),
          ethers.parseUnits('400', 6),
          ethers.parseUnits('595', 6),
          ethers.id('invalid-launch-accounting'),
        ),
      ).to.be.revertedWith('invalid launch settlement schedule');
    });

    it('Should create multiple trades with incrementing nonces', async function () {
      const amount = ethers.parseUnits('106004', 6);
      const hash1 = ethers.id('hash1');
      const hash2 = ethers.id('hash2');

      const blockTimestamp = (await ethers.provider.getBlock('latest'))!.timestamp;
      const deadline = BigInt(blockTimestamp + 3600);

      const nonce0 = await escrow.authorizationNonces(buyer.address);

      // First trade with nonce 0
      const sig1 = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount: amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash: hash1,
        nonce: nonce0,
        deadline,
      });

      await createTradeWithAuthorizationForTest(
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

      const nonce1 = await escrow.authorizationNonces(buyer.address);
      // Second trade with nonce 1
      const sig2 = await signCreateTradeAuthorization(buyer, {
        buyer: buyer.address,
        supplier: supplier.address,
        totalAmount: amount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash: hash2,
        nonce: nonce1,
        deadline,
      });

      await createTradeWithAuthorizationForTest(
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
      expect(await escrow.authorizationNonces(buyer.address)).to.equal(2);
    });

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
      ).to.be.revertedWith('bad authorization');
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
      ).to.be.revertedWith('bad authorization nonce'); // got rejected because of the nonce
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
      ).to.be.revertedWith('supplier required');

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
      ).to.be.revertedWith('supplier cannot be escrow');

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
      ).to.be.revertedWith('ricardian hash required');

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
      ).to.be.revertedWith('breakdown mismatch');
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
      ).to.be.revertedWith('bad authorization nonce');
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
      ).to.be.revertedWith('authorization expired');
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
      ).to.be.revertedWith('bad authorization');
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
      ).to.be.revertedWith('bad authorization');
    });
  });

  describe('Gasless typed authorizations', function () {
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
  });

  describe('Complete Flow (Without dispute)', function () {
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

      await expect(escrow.connect(oracle).confirmArrival(tradeId)).to.emit(
        escrow,
        'ArrivalConfirmed',
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

    it('Should confirm arrival', async function () {
      await expect(escrow.connect(oracle).confirmArrival(tradeId)).to.emit(
        escrow,
        'ArrivalConfirmed',
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
      ).to.be.revertedWith('unsupported inspection window');
    });

    it('Should release the final tranche immediately after inspection acceptance', async function () {
      const supplierBefore = await usdc.balanceOf(supplier.address);
      await escrow.connect(oracle).confirmInspectionAvailable(tradeId, 72 * 3600);

      await expect(escrow.connect(oracle).finalizeAfterInspectionAcceptance(tradeId))
        .to.emit(escrow, 'InspectionAcceptedForFinalRelease')
        .and.to.emit(escrow, 'FinalTrancheReleased');

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(4);
      expect(await usdc.balanceOf(supplier.address)).to.equal(
        supplierBefore + trade.supplierSecondTranche,
      );
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

      await expect(escrow.connect(buyer).finalizeAfterDisputeWindow(tradeId)).to.be.revertedWith(
        'only oracle or admin',
      );
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
      await escrow.connect(oracle).confirmArrival(tradeId);
    });

    it('Should allow buyer to open a dispute during the 72-hour notice window', async function () {
      await expect(openDisputeAsBuyer(tradeId)).to.emit(escrow, 'DisputeOpenedByBuyer');

      const trade = await escrow.trades(tradeId);
      expect(trade.status).to.equal(3); // FROZEN
    });

    it('Should reject a dispute after the 72-hour notice window', async function () {
      await time.increase(72 * 3600 + 1);

      await expect(openDisputeAsBuyer(tradeId)).to.be.revertedWith('window closed');
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
      ).to.be.revertedWith('bad authorization');
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
      ).to.be.revertedWith('bad authorization');
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
      ).to.be.revertedWith('bad authorization');
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

      await expect(escrow.connect(buyer).proposeDisputeSolution(tradeId, 0)).to.be.revertedWith(
        'only admin',
      );
    });

    it('Should reject dispute approval from non-admin', async function () {
      await openDisputeAsBuyer(tradeId);
      await escrow.connect(admin1).proposeDisputeSolution(tradeId, 0);

      await expect(escrow.connect(buyer).approveDisputeSolution(0)).to.be.revertedWith(
        'only admin',
      );
    });

    it('Should enforce dispute proposal expiry and allow manual cancellation', async function () {
      await openDisputeAsBuyer(tradeId);
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
      await openDisputeAsBuyer(tradeId);
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
      await openDisputeAsBuyer(tradeId);
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

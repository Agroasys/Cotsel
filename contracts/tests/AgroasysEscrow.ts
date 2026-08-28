/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'hardhat';
import { AgroasysEscrow, MockUSDC } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { registerDeploymentTests } from './agroasysEscrow/deployment';
import { registerEmergencyControlTests } from './agroasysEscrow/emergency-controls';
import { registerPauseControlTests } from './agroasysEscrow/pause-controls';
import { registerTimeoutAndTreasuryGuardTests } from './agroasysEscrow/timeouts-and-treasury-guards';
import { registerCreateTradeHappyPathTests } from './agroasysEscrow/create-trade-happy-path';
import { registerCreateTradeValidationTests } from './agroasysEscrow/create-trade-validation';
import { registerGaslessAndLifecycleTests } from './agroasysEscrow/gasless-and-lifecycle';
import { registerInspectionTests } from './agroasysEscrow/inspection';
import { registerDisputeTests } from './agroasysEscrow/disputes';
import { registerGovernanceTests } from './agroasysEscrow/governance';
import { registerExpiryBoundaryTests } from './agroasysEscrow/expiry-boundaries';

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
let operator1: SignerWithAddress;
let operator2: SignerWithAddress;

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
    | 'finalizeAfterDisputeWindowWithAuthorization'
    | 'finalizeAfterInspectionAcceptanceWithAuthorization',
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

async function finalizeAfterInspectionAcceptanceAsBuyer(tradeId: bigint) {
  return executeUserActionWithAuthorization(
    tradeId,
    5,
    buyer,
    'finalizeAfterInspectionAcceptanceWithAuthorization',
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
  await escrow.connect(admin1).proposeUnpause(0, 0, ethers.id('global-recovery'));
  await escrow.connect(admin2).approveUnpause();
}

async function unpauseClaimsWithQuorum() {
  await escrow.connect(admin1).proposeUnpause(1, 0, ethers.id('claims-recovery'));
  await escrow.connect(admin2).approveUnpause();
}

async function unpauseTradeWithQuorum(tradeId: bigint) {
  await escrow.connect(admin1).proposeUnpause(2, tradeId, ethers.id(`trade-${tradeId}-recovery`));
  await escrow.connect(admin2).approveUnpause();
}

async function rotateTreasuryPayoutReceiver(newReceiver: string, proposalId: bigint = 0n) {
  await escrow.connect(admin1).proposeTreasuryPayoutAddressUpdate(newReceiver);
  await escrow.connect(admin2).approveTreasuryPayoutAddressUpdate(proposalId);
  await time.increase(24 * 3600 + 1);
  await escrow.connect(admin1).executeTreasuryPayoutAddressUpdate(proposalId);
}

export const getAgroasysEscrowHarness = () => ({
  escrow,
  usdc,
  buyer,
  supplier,
  treasury,
  oracle,
  relayer,
  admin1,
  admin2,
  admin3,
  operator1,
  operator2,
  createSignature,
  signCreateTradeAuthorization,
  signUserActionAuthorization,
  signUsdcReceiveAuthorization,
  createTradeWithAuthorizationForTest,
  executeUserActionWithAuthorization,
  openDisputeAsBuyer,
  cancelLockedTradeAfterTimeoutAsBuyer,
  refundInTransitAfterTimeoutAsBuyer,
  finalizeAfterDisputeWindowAsSupplier,
  finalizeAfterInspectionAcceptanceAsBuyer,
  createDefaultTrade,
  unpauseWithQuorum,
  unpauseClaimsWithQuorum,
  unpauseTradeWithQuorum,
  rotateTreasuryPayoutReceiver,
});

export type AgroasysEscrowHarness = ReturnType<typeof getAgroasysEscrowHarness>;

describe('AgroasysEscrow', function () {
  beforeEach(async function () {
    [buyer, supplier, treasury, oracle, relayer, admin1, admin2, admin3, operator1, operator2] =
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

  registerDeploymentTests(getAgroasysEscrowHarness);
  registerEmergencyControlTests(getAgroasysEscrowHarness);
  registerPauseControlTests(getAgroasysEscrowHarness);
  registerTimeoutAndTreasuryGuardTests(getAgroasysEscrowHarness);
  registerCreateTradeHappyPathTests(getAgroasysEscrowHarness);
  registerCreateTradeValidationTests(getAgroasysEscrowHarness);
  registerGaslessAndLifecycleTests(getAgroasysEscrowHarness);
  registerInspectionTests(getAgroasysEscrowHarness);
  registerDisputeTests(getAgroasysEscrowHarness);
  registerGovernanceTests(getAgroasysEscrowHarness);
  registerExpiryBoundaryTests(getAgroasysEscrowHarness);
});

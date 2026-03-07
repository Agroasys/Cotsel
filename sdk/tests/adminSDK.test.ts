/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AdminSDK } from '../src/modules/adminSDK';
import { DisputeStatus } from '../src/types/dispute';
import { AuthorizationError, ValidationError } from '../src/types/errors';
import { TEST_CONFIG, assertRequiredEnv, getAdminSigner, hasRequiredEnv } from './setup';

const describeIntegration = hasRequiredEnv ? describe : describe.skip;

const UNIT_CONFIG = {
  rpc: "http://127.0.0.1:8545",
  chainId: 31337,
  escrowAddress: "0x1000000000000000000000000000000000000001",
  usdcAddress: "0x2000000000000000000000000000000000000002",
};

const RECEIPT = {
  hash: `0x${'1'.repeat(64)}`,
  blockNumber: 123,
};

type MockTx = {
  wait: jest.Mock;
};

type MockContractWithSigner = {
  pause: jest.Mock;
  proposeUnpause: jest.Mock;
  approveUnpause: jest.Mock;
  cancelUnpauseProposal: jest.Mock;
  disableOracleEmergency: jest.Mock;
  pauseClaims: jest.Mock;
  unpauseClaims: jest.Mock;
  proposeDisputeSolution: jest.Mock;
  approveDisputeSolution: jest.Mock;
  cancelExpiredDisputeProposal: jest.Mock;
  proposeOracleUpdate: jest.Mock;
  approveOracleUpdate: jest.Mock;
  executeOracleUpdate: jest.Mock;
  cancelExpiredOracleUpdateProposal: jest.Mock;
  proposeAddAdmin: jest.Mock;
  approveAddAdmin: jest.Mock;
  executeAddAdmin: jest.Mock;
  cancelExpiredAddAdminProposal: jest.Mock;
  claimTreasury: jest.Mock;
  proposeTreasuryPayoutAddressUpdate: jest.Mock;
  approveTreasuryPayoutAddressUpdate: jest.Mock;
  executeTreasuryPayoutAddressUpdate: jest.Mock;
  cancelExpiredTreasuryPayoutAddressUpdateProposal: jest.Mock;
};

function makeSigner(address = '0x1111111111111111111111111111111111111111'): any {
  return {
    getAddress: jest.fn().mockResolvedValue(address),
  };
}

function makeSdkUnit(isAdmin = true) {
  const sdk = new AdminSDK(UNIT_CONFIG);

  const contractWithSigner: MockContractWithSigner = {
    pause: jest.fn(),
    proposeUnpause: jest.fn(),
    approveUnpause: jest.fn(),
    cancelUnpauseProposal: jest.fn(),
    disableOracleEmergency: jest.fn(),
    pauseClaims: jest.fn(),
    unpauseClaims: jest.fn(),
    proposeDisputeSolution: jest.fn(),
    approveDisputeSolution: jest.fn(),
    cancelExpiredDisputeProposal: jest.fn(),
    proposeOracleUpdate: jest.fn(),
    approveOracleUpdate: jest.fn(),
    executeOracleUpdate: jest.fn(),
    cancelExpiredOracleUpdateProposal: jest.fn(),
    proposeAddAdmin: jest.fn(),
    approveAddAdmin: jest.fn(),
    executeAddAdmin: jest.fn(),
    cancelExpiredAddAdminProposal: jest.fn(),
    claimTreasury: jest.fn(),
    proposeTreasuryPayoutAddressUpdate: jest.fn(),
    approveTreasuryPayoutAddressUpdate: jest.fn(),
    executeTreasuryPayoutAddressUpdate: jest.fn(),
    cancelExpiredTreasuryPayoutAddressUpdateProposal: jest.fn(),
  };

  const connect = jest.fn().mockReturnValue(contractWithSigner);
  const parseLog = jest.fn().mockReturnValue(undefined);
  (sdk as any).contract = { connect, interface: { parseLog } };
  jest.spyOn(sdk, 'isAdmin').mockResolvedValue(isAdmin);

  return { sdk, contractWithSigner, connect, parseLog };
}

function mockSuccessCall(mock: jest.Mock): MockTx {
  const tx: MockTx = {
    wait: jest.fn().mockResolvedValue(RECEIPT),
  };
  mock.mockResolvedValue(tx);
  return tx;
}

describe('AdminSDK unit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('pause should call contract and return tx result', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit(true);
    const signer = makeSigner();
    const tx = mockSuccessCall(contractWithSigner.pause);

    const result = await sdk.pause(signer);

    expect(connect).toHaveBeenCalledWith(signer);
    expect(contractWithSigner.pause).toHaveBeenCalledTimes(1);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
  });

  test('unpause flow methods should call matching contract methods', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();

    mockSuccessCall(contractWithSigner.proposeUnpause);
    mockSuccessCall(contractWithSigner.approveUnpause);
    mockSuccessCall(contractWithSigner.cancelUnpauseProposal);

    await expect(sdk.proposeUnpause(signer)).resolves.toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
    await expect(sdk.approveUnpause(signer)).resolves.toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
    await expect(sdk.cancelUnpauseProposal(signer)).resolves.toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });

    expect(contractWithSigner.proposeUnpause).toHaveBeenCalledTimes(1);
    expect(contractWithSigner.approveUnpause).toHaveBeenCalledTimes(1);
    expect(contractWithSigner.cancelUnpauseProposal).toHaveBeenCalledTimes(1);
  });

  test('disableOracleEmergency should call contract and return tx result', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.disableOracleEmergency);

    await expect(sdk.disableOracleEmergency(signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    expect(contractWithSigner.disableOracleEmergency).toHaveBeenCalledTimes(1);
  });

  test('pauseClaims should call contract and return tx result', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.pauseClaims);

    await expect(sdk.pauseClaims(signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    expect(contractWithSigner.pauseClaims).toHaveBeenCalledTimes(1);
  });

  test('unpauseClaims should call contract and return tx result', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.unpauseClaims);

    await expect(sdk.unpauseClaims(signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    expect(contractWithSigner.unpauseClaims).toHaveBeenCalledTimes(1);
  });

  test('pauseClaims and unpauseClaims should reject non-admin signer', async () => {
    const { sdk } = makeSdkUnit(false);
    const signer = makeSigner();

    await expect(sdk.pauseClaims(signer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(sdk.unpauseClaims(signer)).rejects.toBeInstanceOf(AuthorizationError);
  });

  test('dispute expiry cancel should call contract with proposal id', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.cancelExpiredDisputeProposal);

    await expect(sdk.cancelExpiredDisputeProposal(7n, signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    expect(contractWithSigner.cancelExpiredDisputeProposal).toHaveBeenCalledWith(7n);
  });

  test('governance expiry cancel methods should call contract with proposal id', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.cancelExpiredOracleUpdateProposal);
    mockSuccessCall(contractWithSigner.cancelExpiredAddAdminProposal);

    await expect(sdk.cancelExpiredOracleUpdateProposal(2n, signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    await expect(sdk.cancelExpiredAddAdminProposal(3n, signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });

    expect(contractWithSigner.cancelExpiredOracleUpdateProposal).toHaveBeenCalledWith(2n);
    expect(contractWithSigner.cancelExpiredAddAdminProposal).toHaveBeenCalledWith(3n);
  });

  test('treasury sweep should be callable without admin verification', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(false);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.claimTreasury);

    await expect(sdk.claimTreasury(signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    expect(contractWithSigner.claimTreasury).toHaveBeenCalledTimes(1);
    expect(sdk.isAdmin).not.toHaveBeenCalled();
  });

  test('treasury payout receiver governance methods should call matching contract methods', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit(true);
    const signer = makeSigner();
    mockSuccessCall(contractWithSigner.proposeTreasuryPayoutAddressUpdate);
    mockSuccessCall(contractWithSigner.approveTreasuryPayoutAddressUpdate);
    mockSuccessCall(contractWithSigner.executeTreasuryPayoutAddressUpdate);
    mockSuccessCall(contractWithSigner.cancelExpiredTreasuryPayoutAddressUpdateProposal);

    await expect(
      sdk.proposeTreasuryPayoutAddressUpdate('0x2222222222222222222222222222222222222222', signer)
    ).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
      proposalId: undefined,
    });
    await expect(sdk.approveTreasuryPayoutAddressUpdate(11n, signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    await expect(sdk.executeTreasuryPayoutAddressUpdate(11n, signer)).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });
    await expect(
      sdk.cancelExpiredTreasuryPayoutAddressUpdateProposal(11n, signer)
    ).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
    });

    expect(contractWithSigner.proposeTreasuryPayoutAddressUpdate).toHaveBeenCalledWith(
      '0x2222222222222222222222222222222222222222'
    );
    expect(contractWithSigner.approveTreasuryPayoutAddressUpdate).toHaveBeenCalledWith(11n);
    expect(contractWithSigner.executeTreasuryPayoutAddressUpdate).toHaveBeenCalledWith(11n);
    expect(contractWithSigner.cancelExpiredTreasuryPayoutAddressUpdateProposal).toHaveBeenCalledWith(11n);
  });

  test('proposeOracleUpdate returns proposal id when receipt contains OracleUpdateProposed', async () => {
    const { sdk, contractWithSigner, parseLog } = makeSdkUnit(true);
    const signer = makeSigner();
    const tx = mockSuccessCall(contractWithSigner.proposeOracleUpdate);
    tx.wait.mockResolvedValue({
      ...RECEIPT,
      logs: [
        {
          topics: ['0x1'],
          data: '0x2',
        },
      ],
    });
    parseLog.mockReturnValue({
      name: 'OracleUpdateProposed',
      args: {
        proposalId: 9n,
      },
    });

    await expect(
      sdk.proposeOracleUpdate('0x2222222222222222222222222222222222222222', signer),
    ).resolves.toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
      proposalId: 9n,
    });
  });

  test('proposeDisputeSolution should reject unsupported dispute status', async () => {
    const { sdk } = makeSdkUnit(true);
    const signer = makeSigner();

    await expect(
      sdk.proposeDisputeSolution(1n, 99 as DisputeStatus, signer)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('new admin-only actions should reject non-admin signer', async () => {
    const { sdk } = makeSdkUnit(false);
    const signer = makeSigner();

    await expect(sdk.pause(signer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(sdk.disableOracleEmergency(signer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(sdk.cancelExpiredOracleUpdateProposal(1n, signer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      sdk.proposeTreasuryPayoutAddressUpdate('0x2222222222222222222222222222222222222222', signer)
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(sdk.approveTreasuryPayoutAddressUpdate(1n, signer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(sdk.executeTreasuryPayoutAddressUpdate(1n, signer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      sdk.cancelExpiredTreasuryPayoutAddressUpdateProposal(1n, signer)
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describeIntegration('AdminSDK integration smoke', () => {
  let adminSDK: AdminSDK;
  let adminSigner1: any;
  let adminSigner2: any;

  beforeAll(() => {
    assertRequiredEnv();
    adminSDK = new AdminSDK(TEST_CONFIG);
    adminSigner1 = getAdminSigner(1);
    adminSigner2 = getAdminSigner(2);
  });

  test('should verify admin status', async () => {
    const adminAddress1 = await adminSigner1.getAddress();
    const isAdmin1 = await adminSDK.isAdmin(adminAddress1);

    const adminAddress2 = await adminSigner2.getAddress();
    const isAdmin2 = await adminSDK.isAdmin(adminAddress2);

    expect(isAdmin1).toBe(true);
    expect(isAdmin2).toBe(true);
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AdminSDK } from '../src/modules/adminSDK';

const CONFIG = {
  rpc: 'http://127.0.0.1:8545',
  chainId: 84532,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  expectedRuntimeRoles: {
    oracleAddress: '0x2000000000000000000000000000000000000002',
    treasuryAddress: '0x3000000000000000000000000000000000000003',
    treasuryPayoutAddress: '0x3000000000000000000000000000000000000003',
    relayerAddresses: ['0x4000000000000000000000000000000000000004'],
    adminAddresses: [
      '0x5000000000000000000000000000000000000005',
      '0x6000000000000000000000000000000000000006',
      '0x7000000000000000000000000000000000000007',
    ],
    requiredApprovals: 2,
  },
};

function buildSdk() {
  const sdk = new AdminSDK(CONFIG);
  const provider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
    getCode: jest.fn().mockResolvedValue('0x6000'),
  };
  const contract = {
    usdcToken: jest.fn().mockResolvedValue(CONFIG.usdcAddress),
    oracleAddress: jest.fn().mockResolvedValue(CONFIG.expectedRuntimeRoles.oracleAddress),
    treasuryAddress: jest.fn().mockResolvedValue(CONFIG.expectedRuntimeRoles.treasuryAddress),
    treasuryPayoutAddress: jest
      .fn()
      .mockResolvedValue(CONFIG.expectedRuntimeRoles.treasuryPayoutAddress),
    oracleActive: jest.fn().mockResolvedValue(true),
    requiredApprovals: jest.fn().mockResolvedValue(2n),
    admins: jest.fn().mockImplementation(async (index: number) => {
      const address = CONFIG.expectedRuntimeRoles.adminAddresses[index];
      if (!address) throw new Error('index out of bounds');
      return address;
    }),
    isAdmin: jest.fn().mockResolvedValue(true),
    isRelayer: jest.fn().mockResolvedValue(true),
  };
  (sdk as unknown as { provider: typeof provider }).provider = provider;
  (sdk as unknown as { contract: typeof contract }).contract = contract;
  return { sdk, provider, contract };
}

describe('runtime preflight', () => {
  test('accepts the expected chain, code, token, and role matrix', async () => {
    const { sdk } = buildSdk();
    await expect(sdk.preflightRuntime()).resolves.toMatchObject({ ok: true, failureCodes: [] });
  });

  test('returns explicit failures for wrong chain and missing code', async () => {
    const { sdk, provider } = buildSdk();
    provider.getNetwork.mockResolvedValueOnce({ chainId: 1n });
    provider.getCode.mockResolvedValueOnce('0x');

    const result = await sdk.preflightRuntime();
    expect(result.ok).toBe(false);
    expect(result.failureCodes).toEqual(
      expect.arrayContaining(['WRONG_CHAIN', 'CONTRACT_CODE_MISSING']),
    );
  });

  test('rejects token and role drift', async () => {
    const { sdk, contract } = buildSdk();
    contract.usdcToken.mockResolvedValueOnce('0x8000000000000000000000000000000000000008');
    contract.isAdmin.mockResolvedValueOnce(false);

    const result = await sdk.preflightRuntime();
    expect(result.ok).toBe(false);
    expect(result.failureCodes).toEqual(
      expect.arrayContaining(['WRONG_USDC', 'ROLE_STATE_MISMATCH']),
    );
  });

  test('requires an approved role inventory', async () => {
    const { provider, contract } = buildSdk();
    const sdkWithoutRoleInventory = new AdminSDK({
      rpc: CONFIG.rpc,
      chainId: CONFIG.chainId,
      escrowAddress: CONFIG.escrowAddress,
      usdcAddress: CONFIG.usdcAddress,
    });
    (sdkWithoutRoleInventory as unknown as { provider: typeof provider }).provider = provider;
    (sdkWithoutRoleInventory as unknown as { contract: typeof contract }).contract = contract;
    const result = await sdkWithoutRoleInventory.preflightRuntime();
    expect(result.failureCodes).toContain('ROLE_EXPECTATIONS_MISSING');
  });

  test('distinguishes a contract read failure from an unavailable RPC', async () => {
    const { sdk, contract } = buildSdk();
    contract.requiredApprovals.mockRejectedValueOnce(new Error('execution reverted'));

    const result = await sdk.preflightRuntime();
    expect(result.failureCodes).toContain('CONTRACT_READ_FAILED');
    expect(result.failureCodes).not.toContain('RPC_UNAVAILABLE');
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import { createSignerFromEip1193Provider } from '../src/wallet/eip1193';
import type { Eip1193ProviderLike } from '../src/wallet/eip1193';

const UNIT_CONFIG = {
  rpc: 'http://127.0.0.1:8545',
  chainId: 31337,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x2000000000000000000000000000000000000002',
};

const CANONICAL_PAYLOAD = {
  supplier: '0x1111111111111111111111111111111111111111',
  totalAmount: 1_000_000n,
  logisticsAmount: 100_000n,
  platformFeesAmount: 50_000n,
  supplierFirstTranche: 400_000n,
  supplierSecondTranche: 450_000n,
  ricardianHash: `0x${'a'.repeat(64)}`,
};

type BuyerSdkContract = BuyerSDK['contract'];
type BuyerContractReader = Pick<BuyerSdkContract, 'getAuthorizationNonce'>;

class FakeEip1193Provider {
  readonly address = '0x2222222222222222222222222222222222222222';
  readonly calls: Array<{ method: string; params?: readonly unknown[] | Record<string, unknown> }> =
    [];
  private readonly personalSignature = `0x${'1'.repeat(130)}`;
  private readonly typedDataSignature = `0x${'4'.repeat(130)}`;

  async request(args: {
    method: string;
    params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown> {
    this.calls.push(args);

    switch (args.method) {
      case 'eth_chainId':
        return '0x7a69';
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [this.address];
      case 'personal_sign':
        return this.personalSignature;
      case 'eth_signTypedData_v4':
        return this.typedDataSignature;
      default:
        throw new Error(`Unhandled EIP-1193 method in test fixture: ${args.method}`);
    }
  }
}

describe('Web3Auth-compatible signer validation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('createSignerFromEip1193Provider signs through personal_sign', async () => {
    const provider = new FakeEip1193Provider();
    const signer = await createSignerFromEip1193Provider(provider);

    const address = await signer.getAddress();
    const signature = await signer.signMessage(new TextEncoder().encode('cotsel-web3auth-check'));
    const methods = provider.calls.map((call) => call.method);
    const personalSignCall = provider.calls.find((call) => call.method === 'personal_sign');

    expect(address).toBe(provider.address);
    expect(signature).toBe(`0x${'1'.repeat(130)}`);
    expect(methods.filter((method) => method === 'eth_chainId')).toHaveLength(1);
    expect(methods.filter((method) => method === 'eth_accounts')).toHaveLength(2);
    expect(methods.at(-1)).toBe('personal_sign');
    expect(personalSignCall?.params).toEqual([expect.any(String), provider.address]);
  });

  test('BuyerSDK.createGaslessTradeAuthorization accepts an EIP-1193 signer', async () => {
    const provider = new FakeEip1193Provider();
    const buyerSigner = await createSignerFromEip1193Provider(provider);
    const buyerSdk = new BuyerSDK(UNIT_CONFIG);

    (buyerSdk as unknown as { contract: BuyerContractReader }).contract = {
      getAuthorizationNonce: jest.fn().mockResolvedValue(7n),
    } as unknown as BuyerContractReader;

    const result = await buyerSdk.createGaslessTradeAuthorization(CANONICAL_PAYLOAD, buyerSigner);
    const methods = provider.calls.map((call) => call.method);
    const typedDataCall = provider.calls.find((call) => call.method === 'eth_signTypedData_v4');

    expect(result).toMatchObject({
      buyer: provider.address,
      supplier: CANONICAL_PAYLOAD.supplier,
      totalAmount: CANONICAL_PAYLOAD.totalAmount,
      nonce: 7n,
      signature: `0x${'4'.repeat(130)}`,
    });
    expect(methods.filter((method) => method === 'eth_chainId')).toHaveLength(2);
    expect(methods.filter((method) => method === 'eth_accounts')).toHaveLength(2);
    expect(methods).toContain('eth_signTypedData_v4');
    expect(typedDataCall?.params).toEqual([provider.address, expect.any(String)]);
  });

  test('createSignerFromEip1193Provider rejects providers without request support', async () => {
    const invalidProvider = {} as unknown as Eip1193ProviderLike;
    await expect(createSignerFromEip1193Provider(invalidProvider)).rejects.toThrow(
      'EIP-1193 provider must expose a request(...) function',
    );
  });
});

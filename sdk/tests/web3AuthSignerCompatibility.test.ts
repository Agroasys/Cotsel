/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import { createSignerFromEip1193Provider } from '../src/wallet/eip1193';
import type { Eip1193ProviderLike } from '../src/wallet/eip1193';
import { Interface } from 'ethers';

const UNIT_CONFIG = {
  rpc: 'http://127.0.0.1:8545',
  chainId: 31337,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x2000000000000000000000000000000000000002',
};

const TRADE_LOCKED_INTERFACE = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
]);

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
type BuyerContractConnector = Pick<BuyerSdkContract, 'connect' | 'interface'>;

class FakeEip1193Provider {
  readonly address = '0x2222222222222222222222222222222222222222';
  readonly calls: Array<{ method: string; params?: readonly unknown[] | Record<string, unknown> }> =
    [];
  private readonly signature = `0x${'1'.repeat(130)}`;

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
        return this.signature;
      default:
        throw new Error(`Unhandled EIP-1193 method in test fixture: ${args.method}`);
    }
  }
}

function encodeTradeLockedLog(tradeId: bigint) {
  return TRADE_LOCKED_INTERFACE.encodeEventLog(TRADE_LOCKED_INTERFACE.getEvent('TradeLocked')!, [
    tradeId,
    '0x2222222222222222222222222222222222222222',
    CANONICAL_PAYLOAD.supplier,
    CANONICAL_PAYLOAD.totalAmount,
    CANONICAL_PAYLOAD.logisticsAmount,
    CANONICAL_PAYLOAD.platformFeesAmount,
    CANONICAL_PAYLOAD.supplierFirstTranche,
    CANONICAL_PAYLOAD.supplierSecondTranche,
    CANONICAL_PAYLOAD.ricardianHash,
  ]);
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

  test('BuyerSDK.createTrade accepts an EIP-1193 signer, auto-approves, and submits the lock flow', async () => {
    const provider = new FakeEip1193Provider();
    const buyerSigner = await createSignerFromEip1193Provider(provider);
    const buyerSdk = new BuyerSDK(UNIT_CONFIG);

    const encodedLog = encodeTradeLockedLog(42n);
    const createTrade = jest.fn().mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: `0x${'2'.repeat(64)}`,
        blockNumber: 456,
        logs: [
          {
            address: UNIT_CONFIG.escrowAddress,
            topics: encodedLog.topics,
            data: encodedLog.data,
          },
        ],
      }),
    });

    const connect = jest.fn().mockImplementation((signer) => {
      expect(signer).toBe(buyerSigner);
      return { createTrade };
    });

    (buyerSdk as unknown as { contract: BuyerContractConnector }).contract = {
      connect,
      interface: TRADE_LOCKED_INTERFACE,
    } as unknown as BuyerContractConnector;

    jest.spyOn(buyerSdk, 'getUSDCAllowance').mockResolvedValue(0n);
    const approveUsdcSpy = jest.spyOn(buyerSdk, 'approveUSDC').mockResolvedValue({
      txHash: `0x${'3'.repeat(64)}`,
      blockNumber: 123,
    });
    jest.spyOn(buyerSdk, 'getBuyerNonce').mockResolvedValue(7n);
    jest
      .spyOn(buyerSdk, 'getTreasuryAddress')
      .mockResolvedValue('0x3000000000000000000000000000000000000003');

    const result = await buyerSdk.createTrade(CANONICAL_PAYLOAD, buyerSigner);
    const methods = provider.calls.map((call) => call.method);
    const personalSignCall = provider.calls.find((call) => call.method === 'personal_sign');

    expect(approveUsdcSpy).toHaveBeenCalledWith(CANONICAL_PAYLOAD.totalAmount, buyerSigner);
    expect(connect).toHaveBeenCalledWith(buyerSigner);
    expect(createTrade).toHaveBeenCalledTimes(1);
    expect(createTrade).toHaveBeenCalledWith(
      CANONICAL_PAYLOAD.supplier,
      CANONICAL_PAYLOAD.totalAmount,
      CANONICAL_PAYLOAD.logisticsAmount,
      CANONICAL_PAYLOAD.platformFeesAmount,
      CANONICAL_PAYLOAD.supplierFirstTranche,
      CANONICAL_PAYLOAD.supplierSecondTranche,
      CANONICAL_PAYLOAD.ricardianHash,
      7n,
      expect.any(Number),
      `0x${'1'.repeat(130)}`,
    );
    expect(result).toEqual({
      txHash: `0x${'2'.repeat(64)}`,
      blockNumber: 456,
      tradeId: '42',
    });
    expect(methods.filter((method) => method === 'eth_chainId')).toHaveLength(2);
    expect(methods.filter((method) => method === 'eth_accounts')).toHaveLength(2);
    expect(methods).toContain('personal_sign');
    expect(personalSignCall?.params).toEqual([expect.any(String), provider.address]);
  });

  test('createSignerFromEip1193Provider rejects providers without request support', async () => {
    const invalidProvider = {} as unknown as Eip1193ProviderLike;
    await expect(createSignerFromEip1193Provider(invalidProvider)).rejects.toThrow(
      'EIP-1193 provider must expose a request(...) function',
    );
  });
});

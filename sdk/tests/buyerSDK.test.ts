/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import type { ethers } from 'ethers';
import { Interface } from 'ethers';
import { IERC20__factory } from '../src/types/typechain-types/factories/@openzeppelin/contracts/token/ERC20/IERC20__factory';
import { TEST_CONFIG, assertRequiredEnv, getBuyerSigner, hasRequiredEnv } from './setup';
import { SponsoredAction } from '../src/types/trade';

const describeIntegration = hasRequiredEnv ? describe : describe.skip;

const UNIT_CONFIG = {
  rpc: 'http://127.0.0.1:8545',
  chainId: 31337,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x2000000000000000000000000000000000000002',
};

const TRADE_LOCKED_INTERFACE = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
]);

type MockContractWithSigner = {
  openDispute: jest.Mock;
  cancelLockedTradeAfterTimeout: jest.Mock;
  refundInTransitAfterTimeout: jest.Mock;
};

type BuyerSignerLike = Pick<ethers.Signer, 'getAddress' | 'signMessage' | 'provider'>;
type TypedBuyerSignerLike = BuyerSignerLike & Pick<ethers.Signer, 'signTypedData'>;
type BuyerSdkContract = BuyerSDK['contract'];
type BuyerContractConnector = Pick<BuyerSdkContract, 'connect' | 'interface'>;
type BuyerWriteInvocation = (sdk: BuyerSDK, signer: ethers.Signer) => Promise<unknown>;

function makeBuyerSigner(address = '0x2222222222222222222222222222222222222222'): {
  signer: ethers.Signer;
  provider: { getNetwork: jest.Mock };
} {
  const provider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
  };
  const signer: TypedBuyerSignerLike = {
    getAddress: jest.fn().mockResolvedValue(address),
    signMessage: jest.fn().mockResolvedValue(`0x${'1'.repeat(130)}`),
    signTypedData: jest.fn().mockResolvedValue(`0x${'4'.repeat(130)}`),
    provider: provider as unknown as ethers.Signer['provider'],
  };
  return {
    signer: signer as unknown as ethers.Signer,
    provider,
  };
}

function makeSdkUnit() {
  const sdk = new BuyerSDK(UNIT_CONFIG);

  const contractWithSigner: MockContractWithSigner = {
    openDispute: jest.fn(),
    cancelLockedTradeAfterTimeout: jest.fn(),
    refundInTransitAfterTimeout: jest.fn(),
  };

  const connect = jest.fn().mockReturnValue(contractWithSigner);
  (sdk as unknown as { contract: BuyerContractConnector }).contract = {
    connect,
    interface: TRADE_LOCKED_INTERFACE,
    getAuthorizationNonce: jest.fn().mockResolvedValue(9n),
  } as unknown as BuyerContractConnector;
  jest.spyOn(sdk, 'getUSDCAllowance').mockResolvedValue(1_000_000n);
  jest.spyOn(sdk, 'getBuyerNonce').mockResolvedValue(7n);
  jest
    .spyOn(sdk, 'getTreasuryAddress')
    .mockResolvedValue('0x3000000000000000000000000000000000000003');

  return { sdk, contractWithSigner, connect };
}

const networkMismatchCases: Array<[string, BuyerWriteInvocation]> = [
  ['openDispute', (sdk, signer) => sdk.openDispute(10n, signer)],
  [
    'cancelLockedTradeAfterTimeout',
    (sdk, signer) => sdk.cancelLockedTradeAfterTimeout(11n, signer),
  ],
  ['refundInTransitAfterTimeout', (sdk, signer) => sdk.refundInTransitAfterTimeout(12n, signer)],
];

describe('BuyerSDK unit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('createTrade should reject signer network mismatches', async () => {
    const { sdk } = makeSdkUnit();
    const { signer, provider } = makeBuyerSigner();
    provider.getNetwork.mockResolvedValueOnce({ chainId: 1n });

    await expect(
      sdk.createTrade(
        {
          supplier: '0x1111111111111111111111111111111111111111',
          totalAmount: 1000000n,
          logisticsAmount: 0n,
          platformFeesAmount: 0n,
          supplierFirstTranche: 400000n,
          supplierSecondTranche: 600000n,
          ricardianHash: `0x${'a'.repeat(64)}`,
        },
        signer,
      ),
    ).rejects.toThrow('wrong network');
  });

  test('approveUSDC should reject signer network mismatches', async () => {
    const { sdk } = makeSdkUnit();
    const { signer, provider } = makeBuyerSigner();
    const connectSpy = jest.spyOn(IERC20__factory, 'connect');
    provider.getNetwork.mockResolvedValueOnce({ chainId: 1n });

    await expect(sdk.approveUSDC(1000000n, signer)).rejects.toThrow('wrong network');
    expect(connectSpy).not.toHaveBeenCalled();
  });

  test('createGaslessTradeAuthorization builds typed authorization from on-chain nonce', async () => {
    const { sdk } = makeSdkUnit();
    const { signer } = makeBuyerSigner();

    const result = await sdk.createGaslessTradeAuthorization(
      {
        supplier: '0x1111111111111111111111111111111111111111',
        totalAmount: 1000000n,
        logisticsAmount: 0n,
        platformFeesAmount: 0n,
        supplierFirstTranche: 400000n,
        supplierSecondTranche: 600000n,
        ricardianHash: `0x${'a'.repeat(64)}`,
        deadline: 123456,
      },
      signer,
    );

    expect(result).toMatchObject({
      buyer: '0x2222222222222222222222222222222222222222',
      supplier: '0x1111111111111111111111111111111111111111',
      totalAmount: 1000000n,
      nonce: 9n,
      deadline: 123456,
      signature: `0x${'4'.repeat(130)}`,
    });
  });

  test('createUsdcReceiveAuthorization targets escrow and splits EIP-3009 signature', async () => {
    const { sdk } = makeSdkUnit();
    const { signer } = makeBuyerSigner();
    const signature = `0x${'1'.repeat(64)}${'2'.repeat(64)}1b`;
    (signer.signTypedData as jest.Mock).mockResolvedValueOnce(signature);

    const result = await sdk.createUsdcReceiveAuthorization(1000000n, signer, {
      validAfter: 10,
      validBefore: 20,
      nonce: `0x${'5'.repeat(64)}`,
      tokenName: 'Mock USDC',
    });

    expect(result).toMatchObject({
      from: '0x2222222222222222222222222222222222222222',
      to: UNIT_CONFIG.escrowAddress,
      value: 1000000n,
      validAfter: 10,
      validBefore: 20,
      nonce: `0x${'5'.repeat(64)}`,
      signature,
      v: 27,
      r: `0x${'1'.repeat(64)}`,
      s: `0x${'2'.repeat(64)}`,
    });
  });

  test('createGaslessUserActionAuthorization builds relayed buyer action payloads', async () => {
    const { sdk } = makeSdkUnit();
    const { signer } = makeBuyerSigner();

    const result = await sdk.createGaslessUserActionAuthorization(
      SponsoredAction.OPEN_DISPUTE,
      42n,
      signer,
      654321,
    );

    expect(result).toEqual({
      user: '0x2222222222222222222222222222222222222222',
      action: SponsoredAction.OPEN_DISPUTE,
      tradeId: 42n,
      nonce: 9n,
      deadline: 654321,
      signature: `0x${'4'.repeat(130)}`,
    });
  });

  test('createTrade should reject direct buyer-paid execution', async () => {
    const { sdk, connect } = makeSdkUnit();
    const { signer } = makeBuyerSigner();

    await expect(
      sdk.createTrade(
        {
          supplier: '0x1111111111111111111111111111111111111111',
          totalAmount: 1000000n,
          logisticsAmount: 0n,
          platformFeesAmount: 0n,
          supplierFirstTranche: 400000n,
          supplierSecondTranche: 600000n,
          ricardianHash: `0x${'a'.repeat(64)}`,
        },
        signer,
      ),
    ).rejects.toThrow('Direct buyer-paid createTrade was removed');
    expect(connect).not.toHaveBeenCalled();
  });

  test('openDispute should reject direct buyer-paid execution', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeBuyerSigner();

    await expect(sdk.openDispute(10n, signer)).rejects.toThrow(
      'Direct buyer-paid openDispute was removed',
    );

    expect(connect).not.toHaveBeenCalled();
    expect(contractWithSigner.openDispute).not.toHaveBeenCalled();
  });

  test('cancelLockedTradeAfterTimeout should reject direct buyer-paid execution', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeBuyerSigner();

    await expect(sdk.cancelLockedTradeAfterTimeout(11n, signer)).rejects.toThrow(
      'Direct buyer-paid cancelLockedTradeAfterTimeout was removed',
    );

    expect(connect).not.toHaveBeenCalled();
    expect(contractWithSigner.cancelLockedTradeAfterTimeout).not.toHaveBeenCalled();
  });

  test('refundInTransitAfterTimeout should reject direct buyer-paid execution', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeBuyerSigner();

    await expect(sdk.refundInTransitAfterTimeout(12n, signer)).rejects.toThrow(
      'Direct buyer-paid refundInTransitAfterTimeout was removed',
    );

    expect(connect).not.toHaveBeenCalled();
    expect(contractWithSigner.refundInTransitAfterTimeout).not.toHaveBeenCalled();
  });

  for (const [name, invoke] of networkMismatchCases) {
    test(`${name} should reject signer network mismatches`, async () => {
      const { sdk, connect } = makeSdkUnit();
      const { signer, provider } = makeBuyerSigner();
      provider.getNetwork.mockResolvedValueOnce({ chainId: 1n });

      await expect(invoke(sdk, signer)).rejects.toThrow('wrong network');
      expect(connect).not.toHaveBeenCalled();
    });
  }
});

describeIntegration('BuyerSDK integration smoke', () => {
  let buyerSDK: BuyerSDK;
  let buyerSigner: ethers.Signer;

  beforeAll(() => {
    assertRequiredEnv();
    buyerSDK = new BuyerSDK(TEST_CONFIG);
    buyerSigner = getBuyerSigner();
  });

  test('should get buyer nonce', async () => {
    const buyerAddress = await buyerSigner.getAddress();
    const nonce = await buyerSDK.getBuyerNonce(buyerAddress);

    expect(typeof nonce).toBe('bigint');
    expect(nonce).toBeGreaterThanOrEqual(0n);
  });

  test('should check USDC balance and allowance', async () => {
    const buyerAddress = await buyerSigner.getAddress();

    const balance = await buyerSDK.getUSDCBalance(buyerAddress);
    const allowance = await buyerSDK.getUSDCAllowance(buyerAddress);

    expect(typeof balance).toBe('bigint');
    expect(typeof allowance).toBe('bigint');
  });
});

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { BuyerSDK } from '../src/modules/buyerSDK';
import type { ethers } from 'ethers';
import { Interface } from 'ethers';
import { IERC20__factory } from '../src/types/typechain-types/factories/@openzeppelin/contracts/token/ERC20/IERC20__factory';
import { TEST_CONFIG, assertRequiredEnv, getBuyerSigner, hasRequiredEnv } from './setup';

const describeIntegration = hasRequiredEnv ? describe : describe.skip;

const UNIT_CONFIG = {
  rpc: 'http://127.0.0.1:8545',
  chainId: 31337,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x2000000000000000000000000000000000000002',
};

const RECEIPT = {
  hash: `0x${'2'.repeat(64)}`,
  blockNumber: 456,
};
const TRADE_LOCKED_INTERFACE = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
]);

type MockContractWithSigner = {
  createTrade?: jest.Mock;
  openDispute: jest.Mock;
  cancelLockedTradeAfterTimeout: jest.Mock;
  refundInTransitAfterTimeout: jest.Mock;
  claim: jest.Mock;
};

type BuyerSignerLike = Pick<ethers.Signer, 'getAddress' | 'signMessage' | 'provider'>;
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
  const signer: BuyerSignerLike = {
    getAddress: jest.fn().mockResolvedValue(address),
    signMessage: jest.fn().mockResolvedValue(`0x${'1'.repeat(130)}`),
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
    createTrade: jest.fn(),
    openDispute: jest.fn(),
    cancelLockedTradeAfterTimeout: jest.fn(),
    refundInTransitAfterTimeout: jest.fn(),
    claim: jest.fn(),
  };

  const connect = jest.fn().mockReturnValue(contractWithSigner);
  (sdk as unknown as { contract: BuyerContractConnector }).contract = {
    connect,
    interface: TRADE_LOCKED_INTERFACE,
  } as unknown as BuyerContractConnector;
  jest.spyOn(sdk, 'getUSDCAllowance').mockResolvedValue(1_000_000n);
  jest.spyOn(sdk, 'getBuyerNonce').mockResolvedValue(7n);
  jest
    .spyOn(sdk, 'getTreasuryAddress')
    .mockResolvedValue('0x3000000000000000000000000000000000000003');

  return { sdk, contractWithSigner, connect };
}

function mockSuccessCall(mock: jest.Mock) {
  const tx = {
    wait: jest.fn().mockResolvedValue(RECEIPT),
  };
  mock.mockResolvedValue(tx);
  return tx;
}

const networkMismatchCases: Array<[string, BuyerWriteInvocation]> = [
  ['openDispute', (sdk, signer) => sdk.openDispute(10n, signer)],
  [
    'cancelLockedTradeAfterTimeout',
    (sdk, signer) => sdk.cancelLockedTradeAfterTimeout(11n, signer),
  ],
  ['refundInTransitAfterTimeout', (sdk, signer) => sdk.refundInTransitAfterTimeout(12n, signer)],
  ['claim', (sdk, signer) => sdk.claim(signer)],
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

  test('createTrade should surface tradeId from TradeLocked receipt logs', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit();
    const { signer } = makeBuyerSigner();
    const encodedLog = TRADE_LOCKED_INTERFACE.encodeEventLog(
      TRADE_LOCKED_INTERFACE.getEvent('TradeLocked')!,
      [
        99n,
        '0x2222222222222222222222222222222222222222',
        '0x1111111111111111111111111111111111111111',
        1000000n,
        0n,
        0n,
        400000n,
        600000n,
        `0x${'a'.repeat(64)}`,
      ],
    );
    const tx = {
      wait: jest.fn().mockResolvedValue({
        ...RECEIPT,
        logs: [
          {
            address: UNIT_CONFIG.escrowAddress,
            topics: encodedLog.topics,
            data: encodedLog.data,
          },
        ],
      }),
    };
    contractWithSigner.createTrade = jest.fn().mockResolvedValue(tx);

    const result = await sdk.createTrade(
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
    );

    expect(result).toEqual({
      txHash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
      tradeId: '99',
    });
  });

  test('openDispute should call contract and return tx result', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeBuyerSigner();
    const tx = mockSuccessCall(contractWithSigner.openDispute);

    const result = await sdk.openDispute(10n, signer);

    expect(connect).toHaveBeenCalledWith(signer);
    expect(contractWithSigner.openDispute).toHaveBeenCalledWith(10n);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
  });

  test('cancelLockedTradeAfterTimeout should call contract and return tx result', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit();
    const { signer } = makeBuyerSigner();
    const tx = mockSuccessCall(contractWithSigner.cancelLockedTradeAfterTimeout);

    const result = await sdk.cancelLockedTradeAfterTimeout(11n, signer);

    expect(contractWithSigner.cancelLockedTradeAfterTimeout).toHaveBeenCalledWith(11n);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
  });

  test('refundInTransitAfterTimeout should call contract and return tx result', async () => {
    const { sdk, contractWithSigner } = makeSdkUnit();
    const { signer } = makeBuyerSigner();
    const tx = mockSuccessCall(contractWithSigner.refundInTransitAfterTimeout);

    const result = await sdk.refundInTransitAfterTimeout(12n, signer);

    expect(contractWithSigner.refundInTransitAfterTimeout).toHaveBeenCalledWith(12n);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
  });

  test('claim should call contract and return tx result', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeBuyerSigner();
    const tx = mockSuccessCall(contractWithSigner.claim);

    const result = await sdk.claim(signer);

    expect(connect).toHaveBeenCalledWith(signer);
    expect(contractWithSigner.claim).toHaveBeenCalledTimes(1);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
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

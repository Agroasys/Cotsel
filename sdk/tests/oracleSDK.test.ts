/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { OracleSDK } from '../src/modules/oracleSDK';
import type { ethers } from 'ethers';
import { AuthorizationError } from '../src/types/errors';
import {
  TEST_CONFIG,
  assertRequiredEnv,
  getOptionalEnv,
  getOracleSigner,
  hasRequiredEnv,
} from './setup';

const describeIntegration = hasRequiredEnv ? describe : describe.skip;
const ORACLE_MUTATION_TRADE_ID = (() => {
  const rawTradeId = getOptionalEnv('TEST_TRADE_ID');
  if (!rawTradeId) {
    return undefined;
  }

  try {
    const tradeId = BigInt(rawTradeId);
    if (tradeId < 0n) {
      throw new Error('must be zero or greater');
    }
    return tradeId;
  } catch {
    throw new Error(`Invalid TEST_TRADE_ID "${rawTradeId}". Expected a non-negative integer.`);
  }
})();
const describeOracleMutationIntegration =
  hasRequiredEnv && ORACLE_MUTATION_TRADE_ID !== undefined ? describe : describe.skip;
const UNIT_CONFIG = {
  rpc: 'http://127.0.0.1:8545',
  chainId: 31337,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x2000000000000000000000000000000000000002',
};
const RECEIPT = {
  hash: `0x${'4'.repeat(64)}`,
  blockNumber: 789,
};

type MockContractWithSigner = {
  releaseFundsStage1: jest.Mock;
  confirmArrival: jest.Mock;
  finalizeAfterDisputeWindow: jest.Mock;
};

type OracleSignerLike = Pick<ethers.Signer, 'getAddress' | 'provider'>;
type OracleSdkContract = OracleSDK['contract'];
type OracleContractConnector = Pick<OracleSdkContract, 'connect'>;

function makeOracleSigner(address = '0x1111111111111111111111111111111111111111'): {
  signer: ethers.Signer;
  provider: { getNetwork: jest.Mock };
} {
  const provider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
  };
  const signer: OracleSignerLike = {
    getAddress: jest.fn().mockResolvedValue(address),
    provider: provider as unknown as ethers.Signer['provider'],
  };

  return {
    signer: signer as unknown as ethers.Signer,
    provider,
  };
}

function makeSdkUnit(authorizedOracle = '0x1111111111111111111111111111111111111111') {
  const sdk = new OracleSDK(UNIT_CONFIG);
  const contractWithSigner: MockContractWithSigner = {
    releaseFundsStage1: jest.fn(),
    confirmArrival: jest.fn(),
    finalizeAfterDisputeWindow: jest.fn(),
  };
  const connect = jest.fn().mockReturnValue(contractWithSigner);
  (sdk as unknown as { contract: OracleContractConnector }).contract = {
    connect,
  } as unknown as OracleContractConnector;
  jest.spyOn(sdk, 'getOracleAddress').mockResolvedValue(authorizedOracle);

  return { sdk, contractWithSigner, connect };
}

function mockSuccessCall(mock: jest.Mock) {
  const tx = {
    wait: jest.fn().mockResolvedValue(RECEIPT),
  };
  mock.mockResolvedValue(tx);
  return tx;
}

describe('OracleSDK unit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('releaseFundsStage1 should call contract and return tx result', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeOracleSigner();
    const tx = mockSuccessCall(contractWithSigner.releaseFundsStage1);

    const result = await sdk.releaseFundsStage1(2n, signer);

    expect(connect).toHaveBeenCalledWith(signer);
    expect(contractWithSigner.releaseFundsStage1).toHaveBeenCalledWith(2n);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
  });

  test('confirmArrival should reject unauthorized oracle signer', async () => {
    const { sdk, connect } = makeSdkUnit('0x2222222222222222222222222222222222222222');
    const { signer } = makeOracleSigner();

    await expect(sdk.confirmArrival(3n, signer)).rejects.toBeInstanceOf(AuthorizationError);
    expect(connect).not.toHaveBeenCalled();
  });

  test('releaseFundsStage1 should reject signer network mismatches before oracle verification', async () => {
    const { sdk, connect } = makeSdkUnit();
    const { signer, provider } = makeOracleSigner();
    provider.getNetwork.mockResolvedValueOnce({ chainId: 1n });

    await expect(sdk.releaseFundsStage1(2n, signer)).rejects.toThrow('wrong network');
    expect(sdk.getOracleAddress).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  test('finalizeAfterDisputeWindow should call contract without oracle authorization', async () => {
    const { sdk, contractWithSigner, connect } = makeSdkUnit();
    const { signer } = makeOracleSigner('0x3333333333333333333333333333333333333333');
    const tx = mockSuccessCall(contractWithSigner.finalizeAfterDisputeWindow);

    const result = await sdk.finalizeAfterDisputeWindow(4n, signer);

    expect(connect).toHaveBeenCalledWith(signer);
    expect(contractWithSigner.finalizeAfterDisputeWindow).toHaveBeenCalledWith(4n);
    expect(tx.wait).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txHash: RECEIPT.hash, blockNumber: RECEIPT.blockNumber });
    expect(sdk.getOracleAddress).not.toHaveBeenCalled();
  });

  test('finalizeAfterDisputeWindow should reject signer network mismatches', async () => {
    const { sdk, connect } = makeSdkUnit();
    const { signer, provider } = makeOracleSigner();
    provider.getNetwork.mockResolvedValueOnce({ chainId: 1n });

    await expect(sdk.finalizeAfterDisputeWindow(4n, signer)).rejects.toThrow('wrong network');
    expect(sdk.getOracleAddress).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});

describeIntegration('OracleSDK', () => {
  let oracleSDK: OracleSDK;

  beforeAll(() => {
    assertRequiredEnv();
    oracleSDK = new OracleSDK(TEST_CONFIG);
  });

  test('should get oracle address', async () => {
    const oracleAddress = await oracleSDK.getOracleAddress();
    console.log(`oracle address: ${oracleAddress}`);
  });
});

describeOracleMutationIntegration('OracleSDK mutation integration', () => {
  let oracleSDK: OracleSDK;
  let oracleSigner: ethers.Signer;
  const tradeId = ORACLE_MUTATION_TRADE_ID as bigint;

  beforeAll(() => {
    assertRequiredEnv();
    oracleSDK = new OracleSDK(TEST_CONFIG);
    oracleSigner = getOracleSigner();
  });

  test('should release stage 1 funds', async () => {
    const txHash = await oracleSDK.releaseFundsStage1(tradeId, oracleSigner);

    expect(txHash.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    console.log(`stage 1 released: ${txHash.txHash}`);
  });

  test('should confirm arrival', async () => {
    const txHash = await oracleSDK.confirmArrival(tradeId, oracleSigner);

    expect(txHash.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    console.log(`arrival confirmed: ${txHash.txHash}`);
  });

  test('should finalize after dispute window', async () => {
    const txHash = await oracleSDK.finalizeAfterDisputeWindow(tradeId, oracleSigner);

    expect(txHash.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    console.log(`trade finalized: ${txHash.txHash}`);
  });
});

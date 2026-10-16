/** SPDX-License-Identifier: Apache-2.0 */
import { JsonRpcProvider } from 'ethers';
import {
  parseRetainedSettlementRails,
  selectObservedSettlementRail,
} from '../src/config/retainedSettlementRails';
import { createGaslessFinalityVerifier } from '../src/core/gaslessChainFinality';

const retained = {
  chainId: 84532,
  escrowAddress: `0x${'1'.repeat(40)}`,
  usdcAddress: `0x${'2'.repeat(40)}`,
  rpcUrl: 'https://old-primary.example.test/restricted-key',
  rpcFallbackUrls: ['https://old-witness.example.test/restricted-key'],
  indexerCoverageUrl: 'https://retained-indexer.example.test/financial-coverage',
  reconciliationCoverageUrl: 'https://retained-reconciliation.example.test/financial-coverage',
  railManifestSha256: 'a'.repeat(64),
};
const active = {
  ...retained,
  chainId: 31337,
  escrowAddress: `0x${'3'.repeat(40)}`,
  usdcAddress: `0x${'4'.repeat(40)}`,
};

describe('approved historical settlement rail observation', () => {
  afterEach(() => jest.restoreAllMocks());
  test('defaults to no historical authorization and preserves the active issuance identity', () => {
    expect(parseRetainedSettlementRails(undefined)).toEqual([]);
    const config = {
      ...active,
      retainedSettlementRails: parseRetainedSettlementRails(JSON.stringify([retained])),
    };
    expect(
      selectObservedSettlementRail(config, retained.chainId, retained.escrowAddress),
    ).toMatchObject(retained);
    expect(selectObservedSettlementRail(config, active.chainId, active.escrowAddress)).toBe(config);
    expect(selectObservedSettlementRail(config, 1, retained.escrowAddress)).toBeNull();
    expect(config.chainId).toBe(active.chainId);
  });
  test.each([
    { ...retained, chainId: '84532' },
    { ...retained, railManifestSha256: null },
    { ...retained, rpcFallbackUrls: [retained.rpcUrl + '/other'] },
    { ...retained, rpcUrl: 'http://primary.example.test' },
    { ...retained, indexerCoverageUrl: 'https://user:password@indexer.example.test' },
    { ...retained, unapprovedField: true },
    { ...retained, reconciliationCoverageUrl: undefined },
  ])('rejects malformed or unapproved registry input', (row) => {
    expect(() => parseRetainedSettlementRails(JSON.stringify([row]))).toThrow(
      'requires approved distinct deployments',
    );
  });
  test('rejects ambiguous duplicate deployment identities', () => {
    expect(() => parseRetainedSettlementRails(JSON.stringify([retained, retained]))).toThrow(
      'requires approved distinct deployments',
    );
  });
  test('uses the retained witnesses for an original reverted transaction after active-chain cutover', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    const blockHash = `0x${'b'.repeat(64)}`;
    const receipt = {
      hash,
      status: 0,
      blockHash,
      blockNumber: 100,
      to: retained.escrowAddress,
      from: retained.usdcAddress,
      logs: [],
    };
    jest
      .spyOn(JsonRpcProvider.prototype, 'getNetwork')
      .mockResolvedValue({ chainId: 84532n } as never);
    jest
      .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
      .mockResolvedValue(receipt as never);
    jest
      .spyOn(JsonRpcProvider.prototype, 'getBlock')
      .mockImplementation(
        async (height) => ({ number: height === 100 ? 100 : 200, hash: blockHash }) as never,
      );
    const verifier = createGaslessFinalityVerifier({
      ...active,
      retainedSettlementRails: [retained],
    });
    const proof = await verifier.verifyReceipt(84532, hash, receipt as never);
    expect(proof).toMatchObject({ chainId: '84532', transactionHash: hash });
    expect(JSON.stringify(proof)).not.toContain('restricted-key');
    await expect(verifier.verifyReceipt(1, hash, receipt as never)).resolves.toBeNull();
  });
});

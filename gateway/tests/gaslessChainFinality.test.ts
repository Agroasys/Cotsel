/** SPDX-License-Identifier: Apache-2.0 */
import { JsonRpcProvider } from 'ethers';
import { createGaslessFinalityVerifier } from '../src/core/gaslessChainFinality';
const transactionHash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const finalizedHash = `0x${'c'.repeat(64)}`;
const receipt = {
  hash: transactionHash,
  blockNumber: 100,
  blockHash,
  status: 1,
  to: `0x${'1'.repeat(40)}`,
  from: `0x${'2'.repeat(40)}`,
  logs: [],
};
const config = {
  escrowAddress: `0x${'9'.repeat(40)}`,
  usdcAddress: receipt.to,
  chainId: 84532,
  rpcUrl: 'https://primary.example.test/redacted-key',
  rpcFallbackUrls: ['https://witness.example.test/redacted-key'],
};
describe('gasless finalized chain evidence', () => {
  beforeEach(() => {
    jest
      .spyOn(JsonRpcProvider.prototype, 'getNetwork')
      .mockResolvedValue({ chainId: 84532n } as never);
    jest
      .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
      .mockResolvedValue(receipt as never);
    jest.spyOn(JsonRpcProvider.prototype, 'getBlock').mockImplementation(
      async (tag) =>
        ({
          number: tag === 100 ? 100 : 200,
          hash: tag === 100 ? blockHash : finalizedHash,
        }) as never,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  const verify = () =>
    createGaslessFinalityVerifier(config).verifyReceipt(84532, transactionHash, receipt as never);
  test('accepts canonical finalized receipts without recording RPC credentials', async () => {
    const result = await verify();
    expect(result).toMatchObject({
      policyVersion: 'gasless_dual_rpc_finalized_v1',
      transactionHash,
      blockHash,
      finalizedBlockNumber: '200',
    });
    expect(result?.rpcWitnesses).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('redacted-key');
  });
  test('does not accept a mined receipt ahead of finalized chain state', async () => {
    jest
      .mocked(JsonRpcProvider.prototype.getBlock)
      .mockImplementation(async () => ({ number: 99, hash: blockHash }) as never);
    await expect(verify()).resolves.toBeNull();
  });
  test('does not accept an orphaned receipt', async () => {
    jest
      .mocked(JsonRpcProvider.prototype.getBlock)
      .mockImplementation(
        async (tag) =>
          ({ number: 200, hash: tag === 100 ? `0x${'d'.repeat(64)}` : finalizedHash }) as never,
      );
    await expect(verify()).resolves.toBeNull();
  });
  test('rejects differing receipt logs at identical amounts and block identity', async () => {
    jest.mocked(JsonRpcProvider.prototype.getTransactionReceipt).mockResolvedValueOnce({
      ...receipt,
      logs: [{ address: receipt.to, topics: [], data: '0x01', index: 0 }],
    } as never);
    await expect(verify()).resolves.toBeNull();
  });
  test('rejects two URLs on the same host and rejects a wrong chain', async () => {
    await expect(
      createGaslessFinalityVerifier({
        ...config,
        rpcFallbackUrls: ['https://primary.example.test/other-key'],
      }).verifyReceipt(84532, transactionHash, receipt as never),
    ).resolves.toBeNull();
    jest
      .mocked(JsonRpcProvider.prototype.getNetwork)
      .mockResolvedValueOnce({ chainId: 1n } as never);
    await expect(verify()).resolves.toBeNull();
  });
  test('distinguishes unanimous orphaning from conflicting provider observations', async () => {
    const verifier = createGaslessFinalityVerifier(config);
    await expect(verifier.revalidateBlock(84532, '100', blockHash)).resolves.toBe('canonical');
    jest
      .mocked(JsonRpcProvider.prototype.getBlock)
      .mockImplementation(async () => ({ number: 200, hash: finalizedHash }) as never);
    await expect(verifier.revalidateBlock(84532, '100', blockHash)).resolves.toBe('orphaned');
    jest
      .mocked(JsonRpcProvider.prototype.getBlock)
      .mockResolvedValueOnce({ number: 200, hash: finalizedHash } as never)
      .mockResolvedValueOnce({ number: 100, hash: blockHash } as never);
    await expect(verifier.revalidateBlock(84532, '100', blockHash)).resolves.toBe('unavailable');
  });
  test('never infers a reverted outcome from an unknown receipt status', async () => {
    await expect(
      createGaslessFinalityVerifier(config).verifyReceipt(84532, transactionHash, {
        ...receipt,
        status: null,
      } as never),
    ).resolves.toBeNull();
  });
});

import {
  verifyOracleDispatchFinality,
  createOracleDispatchWitnesses,
} from '../src/blockchain/dispatch-finality';
const scope = '31337:0x3333333333333333333333333333333333333333';
const hash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
function witness(id: string, fault?: string) {
  const receipt = {
    hash,
    from: scope.split(':')[1],
    status: fault === 'revert' ? 0 : 1,
    blockNumber: 100,
    blockHash,
  };
  return {
    id: id.repeat(64),
    provider: {
      getNetwork: jest.fn().mockResolvedValue({ chainId: fault === 'chain' ? 1n : 31337n }),
      getTransactionReceipt: jest.fn().mockResolvedValue(
        fault === 'missing'
          ? null
          : {
              ...receipt,
              ...(fault === 'signer' ? { from: `0x${'4'.repeat(40)}` } : {}),
              ...(fault === 'hash' ? { hash: `0x${'c'.repeat(64)}` } : {}),
              ...(fault === 'status' ? { status: null } : {}),
              ...(fault === 'disagree' ? { status: 0 } : {}),
            },
      ),
      getBlock: jest.fn(async (tag: unknown) =>
        tag === 'finalized'
          ? { number: fault === 'pending' ? 99 : 200 }
          : { number: 100, hash: fault === 'orphan' ? `0x${'c'.repeat(64)}` : blockHash },
      ),
    },
  };
}
describe('Oracle signer dispatch nonce finality', () => {
  it.each(['success', 'revert'])(
    'resolves a finalized %s without asserting payment success',
    async (state) => {
      const evidence = await verifyOracleDispatchFinality(
        [witness('1', state), witness('2', state)] as never,
        scope,
        hash,
      );
      expect(evidence).toMatchObject({
        signerScope: scope,
        transactionHash: hash,
        blockHash,
        receiptStatus: state === 'revert' ? 0 : 1,
      });
    },
  );
  it.each(['chain', 'missing', 'signer', 'hash', 'status', 'disagree', 'pending', 'orphan'])(
    'keeps %s unresolved',
    async (fault) => {
      await expect(
        verifyOracleDispatchFinality([witness('1'), witness('2', fault)] as never, scope, hash),
      ).rejects.toThrow();
    },
  );
  it('does not fall back to one witness or two copies of the same witness', async () => {
    await expect(
      verifyOracleDispatchFinality([witness('1')] as never, scope, hash),
    ).rejects.toThrow();
    await expect(
      verifyOracleDispatchFinality([witness('1'), witness('1')] as never, scope, hash),
    ).rejects.toThrow();
    expect(
      createOracleDispatchWitnesses(['https://rpc.example/a', 'https://rpc.example/b']),
    ).toHaveLength(1);
  });
  it('redacts provider diagnostics', async () => {
    const a = witness('1');
    a.provider.getNetwork.mockRejectedValue(new Error('https://rpc.example/secret-token'));
    await expect(
      verifyOracleDispatchFinality([a, witness('2')] as never, scope, hash),
    ).rejects.toThrow('Independent Oracle dispatch witnesses are unavailable');
  });
});

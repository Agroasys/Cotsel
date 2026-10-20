import { Interface } from 'ethers';
import {
  FinalizedTransactionVerifier,
  createTreasurySweepWitnesses,
} from '../src/core/finalizedTransaction';
const chainId = 31337,
  escrowAddress = `0x${'1'.repeat(40)}`,
  usdcAddress = `0x${'2'.repeat(40)}`,
  treasury = `0x${'3'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`,
  blockHash = `0x${'b'.repeat(64)}`;
const iface = new Interface([
  'function treasuryAddress() view returns(address)',
  'function usdcToken() view returns(address)',
]);
const receipt = { hash, to: escrowAddress, status: 1, blockNumber: 100, blockHash, logs: [] };
const witness = () => ({
  getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
  getBlock: jest.fn(async (height: unknown) => ({
    number: height === 'finalized' ? 200 : 100,
    hash: blockHash,
  })),
  getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
  call: jest.fn(async (request: { data: string }) =>
    request.data === iface.encodeFunctionData('treasuryAddress')
      ? iface.encodeFunctionResult('treasuryAddress', [treasury])
      : iface.encodeFunctionResult('usdcToken', [usdcAddress]),
  ),
});
describe('independent finalized treasury sweep receipts', () => {
  it('captures exact approved deployment, accounting identity and restricted witness evidence', async () => {
    const verifier = new FinalizedTransactionVerifier({
      rail: { chainId, escrowAddress, usdcAddress },
      witnesses: [
        { id: 'a'.repeat(64), provider: witness() },
        { id: 'b'.repeat(64), provider: witness() },
      ] as never,
    });
    expect(await verifier.verify(hash, 100)).toMatchObject({
      finalized: true,
      tokenAddress: usdcAddress,
      treasuryIdentity: treasury,
      escrowAddress,
      finalizedEvidence: {
        policyVersion: 'treasury_dual_rpc_finalized_v1',
        chainId: '31337',
        transactionHash: hash,
        blockHash,
        rpcWitnesses: ['a'.repeat(64), 'b'.repeat(64)],
      },
    });
  });
  it.each([
    'missing',
    'reverted',
    'network',
    'block',
    'unfinalized',
    'wrong-hash',
    'wrong-escrow',
    'wrong-token',
    'logs',
    'unavailable',
  ])('fails closed for %s evidence', async (fault) => {
    const other = witness();
    if (fault === 'missing') other.getTransactionReceipt.mockResolvedValue(null as never);
    if (fault === 'reverted')
      other.getTransactionReceipt.mockResolvedValue({ ...receipt, status: 0 });
    if (fault === 'network') other.getNetwork.mockResolvedValue({ chainId: 84532n });
    if (fault === 'block')
      other.getBlock.mockResolvedValue({ number: 200, hash: `0x${'c'.repeat(64)}` });
    if (fault === 'unfinalized') other.getBlock.mockResolvedValue({ number: 99, hash: blockHash });
    if (fault === 'wrong-hash')
      other.getTransactionReceipt.mockResolvedValue({ ...receipt, hash: `0x${'c'.repeat(64)}` });
    if (fault === 'wrong-escrow')
      other.getTransactionReceipt.mockResolvedValue({ ...receipt, to: treasury });
    if (fault === 'wrong-token')
      other.call.mockResolvedValue(iface.encodeFunctionResult('usdcToken', [treasury]));
    if (fault === 'logs')
      other.getTransactionReceipt.mockResolvedValue({
        ...receipt,
        logs: [{ address: usdcAddress, index: 0, topics: [], data: '0x' }],
      } as never);
    if (fault === 'unavailable')
      other.getNetwork.mockRejectedValue(new Error('controlled witness outage'));
    const verifier = new FinalizedTransactionVerifier({
      rail: { chainId, escrowAddress, usdcAddress },
      witnesses: [
        { id: 'a'.repeat(64), provider: witness() },
        { id: 'b'.repeat(64), provider: other },
      ] as never,
    });
    expect(await verifier.verify(hash, 100)).toMatchObject({ finalized: false });
  });
  it('requires both distinct configured witness identities', async () => {
    for (const witnesses of [
      [],
      [{ id: 'a'.repeat(64), provider: witness() }],
      [
        { id: 'a'.repeat(64), provider: witness() },
        { id: 'a'.repeat(64), provider: witness() },
      ],
    ])
      expect(
        await new FinalizedTransactionVerifier({
          rail: { chainId, escrowAddress, usdcAddress },
          witnesses,
        } as never).verify(hash, 100),
      ).toMatchObject({ finalized: false });
    expect(
      createTreasurySweepWitnesses(['https://same.example.test/a', 'https://same.example.test/b']),
    ).toHaveLength(1);
  });
  it('does not expose provider URLs or raw diagnostics in a failed receipt response', async () => {
    const failing = witness();
    failing.getNetwork.mockRejectedValue(
      new Error('https://provider.example.test/restricted-api-token'),
    );
    const result = await new FinalizedTransactionVerifier({
      rail: { chainId, escrowAddress, usdcAddress },
      witnesses: [
        { id: 'a'.repeat(64), provider: witness() },
        { id: 'b'.repeat(64), provider: failing },
      ] as never,
    }).verify(hash, 100);
    expect(result).toEqual({
      finalized: false,
      detail: 'Independent treasury receipt verification is unavailable',
    });
  });
});

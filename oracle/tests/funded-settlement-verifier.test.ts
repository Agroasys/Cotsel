import { Interface } from 'ethers';
import { verifyFundedSettlementBinding } from '../src/blockchain/funded-settlement-verifier';
import { fundedBindingFixture } from './helpers/fundedBinding';
const iface = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const binding = fundedBindingFixture();
const deployment = {
  chainId: 31337,
  escrowAddress: binding.escrowAddress,
  tokenAddress: binding.tokenAddress,
};
const receipt = () => ({
  hash: binding.fundingTransactionHash,
  status: 1,
  to: binding.escrowAddress,
  blockNumber: 100,
  blockHash: binding.fundingBlockHash,
  logs: [
    {
      address: binding.escrowAddress,
      index: 0,
      ...iface.encodeEventLog(iface.getEvent('TradeLocked')!, [
        '1',
        binding.buyerAddress,
        binding.supplierAddress,
        '1000',
        '100',
        '50',
        '350',
        '500',
        binding.ricardianHash,
      ]),
    },
    {
      address: binding.tokenAddress,
      index: 1,
      ...iface.encodeEventLog(iface.getEvent('Transfer')!, [
        binding.buyerAddress,
        binding.escrowAddress,
        '1000',
      ]),
    },
  ],
});
function witness(changes = {}) {
  return {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt()),
    getBlock: jest.fn(async (height: unknown) =>
      height === 'finalized'
        ? { number: 200, hash: `0x${'d'.repeat(64)}` }
        : { number: 100, hash: binding.fundingBlockHash },
    ),
    ...changes,
  };
}
describe('Oracle original funding evidence before payout submission', () => {
  it('requires exact original funding from two finalized canonical witnesses', async () => {
    await expect(
      verifyFundedSettlementBinding(deployment, [witness(), witness()] as never, binding),
    ).resolves.toBeUndefined();
  });
  it.each([
    { chainId: 84532 },
    { escrowAddress: binding.supplierAddress },
    { tokenAddress: binding.buyerAddress },
  ])('rejects an executor configured for another deployment %#', async (changes) => {
    await expect(
      verifyFundedSettlementBinding(
        { ...deployment, ...changes },
        [witness(), witness()] as never,
        binding,
      ),
    ).rejects.toThrow('deployment');
  });
  it.each([
    'missing',
    'revert',
    'orphan',
    'unfinalized',
    'network',
    'recipient',
    'amount',
    'duplicate',
    'logs_disagree',
    'unavailable',
  ])('rejects %s funding evidence', async (fault) => {
    const b = witness();
    if (fault === 'missing') b.getTransactionReceipt.mockResolvedValue(null);
    if (fault === 'revert') b.getTransactionReceipt.mockResolvedValue({ ...receipt(), status: 0 });
    if (fault === 'orphan')
      b.getBlock.mockResolvedValue({ number: 200, hash: `0x${'e'.repeat(64)}` });
    if (fault === 'unfinalized')
      b.getBlock.mockResolvedValue({ number: 99, hash: binding.fundingBlockHash });
    if (fault === 'network') b.getNetwork.mockResolvedValue({ chainId: 84532n });
    if (fault === 'recipient')
      b.getTransactionReceipt.mockResolvedValue({
        ...receipt(),
        logs: [
          receipt().logs[0],
          {
            address: binding.tokenAddress,
            index: 1,
            ...iface.encodeEventLog(iface.getEvent('Transfer')!, [
              binding.supplierAddress,
              binding.escrowAddress,
              '1000',
            ]),
          },
        ],
      });
    if (fault === 'amount')
      b.getTransactionReceipt.mockResolvedValue({
        ...receipt(),
        logs: [
          receipt().logs[0],
          {
            address: binding.tokenAddress,
            index: 1,
            ...iface.encodeEventLog(iface.getEvent('Transfer')!, [
              binding.buyerAddress,
              binding.escrowAddress,
              '1001',
            ]),
          },
        ],
      });
    if (fault === 'duplicate')
      b.getTransactionReceipt.mockResolvedValue({
        ...receipt(),
        logs: [...receipt().logs, receipt().logs[0]],
      });
    if (fault === 'logs_disagree')
      b.getTransactionReceipt.mockResolvedValue({
        ...receipt(),
        logs: receipt().logs.map((log) => ({ ...log, index: log.index + 4 })),
      });
    if (fault === 'unavailable') b.getBlock.mockRejectedValue(new Error('controlled RPC outage'));
    await expect(
      verifyFundedSettlementBinding(deployment, [witness(), b] as never, binding),
    ).rejects.toThrow();
  });
  it('has no single-witness fallback', async () => {
    await expect(
      verifyFundedSettlementBinding(deployment, [witness()] as never, binding),
    ).rejects.toThrow('deployment');
  });
});

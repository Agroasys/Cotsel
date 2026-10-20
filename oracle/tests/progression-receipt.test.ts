import { Interface } from 'ethers';
import { verifyOracleProgressionReceipt } from '../src/blockchain/progression-receipt';
import { fundedBindingFixture } from './helpers/fundedBinding';
import { TriggerType } from '../src/types/trigger';
const abi = new Interface([
  'function releaseFundsStage1(uint256)',
  'function confirmInspectionAvailable(uint256,uint256)',
  'function finalizeAfterDisputeWindow(uint256)',
  'event FundsReleasedStage1(uint256 indexed tradeId,address indexed supplier,uint256 supplierFirstTranche,address indexed treasury,uint256 logisticsAmount)',
  'event FinalTrancheReleased(uint256 indexed tradeId,address indexed supplier,uint256 supplierSecondTranche)',
  'event InspectionAvailable(uint256 indexed tradeId,uint256 inspectionAvailableAt,uint256 inspectionWindowSeconds,uint256 noticeDeadline)',
  'event SupplierPayoutTransferred(uint256 indexed tradeId,address indexed supplier,uint256 amount,uint8 claimType,address indexed triggeredBy)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const scope = '31337:0x3333333333333333333333333333333333333333';
const hash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
function fixture(type = TriggerType.RELEASE_STAGE_1) {
  const binding = fundedBindingFixture(type);
  const inspection = binding.phase.startsWith('inspection_available_');
  const first = type === TriggerType.RELEASE_STAGE_1;
  const amount = BigInt(binding.supplierPayoutAmount);
  const window =
    type === TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL ? 48 * 3600 : 72 * 3600;
  const log = (name: string, values: unknown[], address = binding.escrowAddress, index = 0) => ({
    address,
    index,
    ...abi.encodeEventLog(abi.getEvent(name)!, values),
  });
  const logs = inspection
    ? [log('InspectionAvailable', ['1', 1000, window, 1000 + window])]
    : [
        first
          ? log('FundsReleasedStage1', [
              '1',
              binding.supplierAddress,
              amount,
              binding.buyerAddress,
              binding.logisticsAmount,
            ])
          : log('FinalTrancheReleased', ['1', binding.supplierAddress, amount]),
        log(
          'SupplierPayoutTransferred',
          ['1', binding.supplierAddress, amount, first ? 0 : 3, scope.split(':')[1]],
          binding.escrowAddress,
          1,
        ),
        log(
          'Transfer',
          [binding.escrowAddress, binding.supplierAddress, amount],
          binding.tokenAddress,
          2,
        ),
      ];
  const receipt = {
    hash,
    from: scope.split(':')[1],
    to: binding.escrowAddress,
    status: 1,
    blockNumber: 100,
    blockHash,
    logs,
  };
  const tx = {
    hash,
    from: scope.split(':')[1],
    to: binding.escrowAddress,
    chainId: 31337n,
    value: 0n,
    data: abi.encodeFunctionData(
      first
        ? 'releaseFundsStage1'
        : inspection
          ? 'confirmInspectionAvailable'
          : 'finalizeAfterDisputeWindow',
      inspection ? ['1', window] : ['1'],
    ),
  };
  const witness = (id: string) => ({
    id: id.repeat(64),
    provider: {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
      getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
      getTransaction: jest.fn().mockResolvedValue(tx),
      getBlock: jest.fn(async (tag: unknown) =>
        tag === 'finalized' ? { number: 200 } : { number: 100, hash: blockHash },
      ),
    },
  });
  return { binding, receipt, tx, log, witness };
}
describe('Original Oracle execution receipt', () => {
  it.each([
    TriggerType.RELEASE_STAGE_1,
    TriggerType.CONFIRM_INSPECTION_AVAILABLE_STANDARD,
    TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL,
    TriggerType.FINALIZE_TRADE,
  ])('verifies original %s input, recipient, amount and finality', async (type) => {
    const f = fixture(type);
    await expect(
      verifyOracleProgressionReceipt(
        [f.witness('1'), f.witness('2')] as never,
        scope,
        hash,
        f.binding,
      ),
    ).resolves.toMatchObject({ transactionHash: hash, receiptStatus: 1 });
  });
  it.each([
    'wrong input',
    'wrong signer',
    'wrong contract',
    'value',
    'missing movement',
    'duplicate movement',
    'wrong recipient',
    'wrong amount',
    'wrong trade',
    'wrong claim type',
    'changed receipt block',
    'revert',
  ])('rejects %s without success', async (fault) => {
    const f = fixture();
    const b = f.witness('2');
    if (fault === 'wrong input')
      b.provider.getTransaction.mockResolvedValue({
        ...f.tx,
        data: abi.encodeFunctionData('releaseFundsStage1', ['2']),
      });
    if (fault === 'wrong signer')
      b.provider.getTransaction.mockResolvedValue({ ...f.tx, from: f.binding.supplierAddress });
    if (fault === 'wrong contract')
      b.provider.getTransaction.mockResolvedValue({ ...f.tx, to: f.binding.supplierAddress });
    if (fault === 'value') b.provider.getTransaction.mockResolvedValue({ ...f.tx, value: 1n });
    if (fault === 'missing movement')
      b.provider.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: f.receipt.logs.slice(0, 2),
      });
    if (fault === 'duplicate movement')
      b.provider.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: [...f.receipt.logs, f.receipt.logs[2]],
      });
    if (fault === 'wrong recipient')
      b.provider.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: [
          ...f.receipt.logs.slice(0, 2),
          f.log(
            'Transfer',
            [f.binding.escrowAddress, f.binding.buyerAddress, 350],
            f.binding.tokenAddress,
            2,
          ),
        ],
      });
    if (fault === 'wrong amount')
      b.provider.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: [
          ...f.receipt.logs.slice(0, 2),
          f.log(
            'Transfer',
            [f.binding.escrowAddress, f.binding.supplierAddress, 351],
            f.binding.tokenAddress,
            2,
          ),
        ],
      });
    if (fault === 'wrong trade')
      b.provider.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: [
          f.log('FundsReleasedStage1', [
            '2',
            f.binding.supplierAddress,
            350,
            f.binding.buyerAddress,
            100,
          ]),
          ...f.receipt.logs.slice(1),
        ],
      });
    if (fault === 'wrong claim type')
      b.provider.getTransactionReceipt.mockResolvedValue({
        ...f.receipt,
        logs: [
          f.receipt.logs[0],
          f.log(
            'SupplierPayoutTransferred',
            ['1', f.binding.supplierAddress, 350, 3, scope.split(':')[1]],
            f.binding.escrowAddress,
            1,
          ),
          f.receipt.logs[2],
        ],
      });
    if (fault === 'changed receipt block')
      b.provider.getTransactionReceipt
        .mockResolvedValueOnce(f.receipt)
        .mockResolvedValue({ ...f.receipt, blockHash: `0x${'c'.repeat(64)}` });
    if (fault === 'revert')
      b.provider.getTransactionReceipt.mockResolvedValue({ ...f.receipt, status: 0 });
    await expect(
      verifyOracleProgressionReceipt([f.witness('1'), b] as never, scope, hash, f.binding),
    ).rejects.toThrow();
  });
});

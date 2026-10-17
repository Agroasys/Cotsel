import { Interface } from 'ethers';
import {
  verifyUserActionFunding,
  type UserActionFundingWitness,
} from '../src/core/userActionFundingVerification';
import type { SettlementUserActionBinding } from '../src/core/settlementUserActionBinding';
const escrow = '0x' + '33'.repeat(20),
  token = '0x' + '44'.repeat(20),
  buyer = '0x' + '11'.repeat(20),
  supplier = '0x' + '22'.repeat(20);
const hash = '0x' + 'ee'.repeat(32),
  transaction = '0x' + 'dd'.repeat(32),
  anchor = '0x' + 'ff'.repeat(32);
const events = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const binding: SettlementUserActionBinding = {
  scopeVersion: 'agroasys.cotsel-user-action-binding.v1',
  ownerServiceId: 'owner',
  packageId: 'package',
  sourceOperationId: 'operation',
  approvalScopeFingerprint: '0x' + 'aa'.repeat(32),
  originalFundingFingerprint: 'cc'.repeat(32),
  phase: 'gasless_user_action',
  action: 'finalize_after_inspection_acceptance',
  signerRole: 'buyer',
  signerAddress: buyer,
  buyerAddress: buyer,
  supplierAddress: supplier,
  chainId: '84532',
  escrowAddress: escrow,
  tokenAddress: token,
  deploymentIdentity: `84532:${escrow}:${token}`,
  tradeId: '7',
  nonce: '9',
  deadline: '2000000000',
  expiresAt: new Date(2000000000000).toISOString(),
  recipient: supplier,
  amount: '400',
  totalAmount: '1000',
  supplierSecondTranche: '400',
  fundingTransactionHash: transaction,
  fundingBlockNumber: '100',
  fundingBlockHash: hash,
  executionScopeHash: '0x' + 'bb'.repeat(32),
};
const deployment = { chainId: 84532, escrowAddress: escrow, usdcAddress: token };
function fixture() {
  const encode = (name: string, args: unknown[], address: string, index: number) => ({
    ...events.encodeEventLog(events.getEvent(name)!, args),
    address,
    index,
  });
  const receipt = {
    status: 1,
    to: escrow,
    hash: transaction,
    blockHash: hash,
    blockNumber: 100,
    logs: [
      encode(
        'TradeLocked',
        ['7', buyer, supplier, 1000, 100, 50, 450, 400, '0x' + 'ab'.repeat(32)],
        escrow,
        0,
      ),
      encode('Transfer', [buyer, escrow, 1000], token, 1),
    ],
  };
  const witness = () => ({
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
    getTransactionReceipt: jest.fn().mockResolvedValue(structuredClone(receipt)),
    getBlock: jest
      .fn()
      .mockImplementation(async (height: unknown) =>
        height === 'finalized'
          ? { number: 200, hash: anchor }
          : { number: Number(height), hash: BigInt(height as bigint) === 100n ? hash : anchor },
      ),
  });
  const first = witness(),
    second = witness();
  return {
    first,
    second,
    receipt,
    witnesses: [first, second] as unknown as UserActionFundingWitness[],
  };
}
describe('independent original user-action funding', () => {
  it('matches both finalized funding receipts, immutable participants/amounts, and actual USDC funding', async () => {
    const f = fixture();
    await expect(
      verifyUserActionFunding(deployment, f.witnesses, binding),
    ).resolves.toBeUndefined();
  });
  it.each([
    { status: 0 },
    { blockHash: anchor },
    { blockNumber: 99 },
    { hash: anchor },
    { to: buyer },
    { logs: [] },
  ])('rejects contradictory original receipt %j', async (change) => {
    const f = fixture();
    f.first.getTransactionReceipt.mockResolvedValue({ ...f.receipt, ...change });
    await expect(verifyUserActionFunding(deployment, f.witnesses, binding)).rejects.toThrow(
      'independent finalized verification',
    );
  });
  it.each([
    { buyerAddress: supplier, signerAddress: supplier },
    { supplierAddress: buyer, recipient: buyer },
    { totalAmount: '999' },
    { supplierSecondTranche: '399', amount: '399' },
    { fundingBlockNumber: '99' },
  ])('rejects plausible but different original instructions %j', async (change) => {
    const f = fixture();
    await expect(
      verifyUserActionFunding(deployment, f.witnesses, { ...binding, ...change }),
    ).rejects.toThrow();
  });
  it('rejects wrong chain and unfinalized funding', async () => {
    const f = fixture();
    f.first.getNetwork.mockResolvedValue({ chainId: 1n });
    await expect(verifyUserActionFunding(deployment, f.witnesses, binding)).rejects.toThrow();
    f.first.getNetwork.mockResolvedValue({ chainId: 84532n });
    f.first.getBlock.mockResolvedValue({ number: 99, hash });
    await expect(verifyUserActionFunding(deployment, f.witnesses, binding)).rejects.toThrow();
  });
  it('rejects RPC disagreement on a common finalized anchor', async () => {
    const f = fixture();
    f.second.getBlock.mockImplementation(async (height: unknown) =>
      height === 'finalized'
        ? { number: 200, hash: anchor }
        : { number: Number(height), hash: Number(height) === 100 ? hash : '0x' + 'aa'.repeat(32) },
    );
    await expect(verifyUserActionFunding(deployment, f.witnesses, binding)).rejects.toThrow();
  });
  it('rejects an extra escrow token movement and disagreed receipt logs', async () => {
    const f = fixture();
    f.second.getTransactionReceipt.mockResolvedValue({
      ...f.receipt,
      logs: [...f.receipt.logs, f.receipt.logs[1]],
    });
    await expect(verifyUserActionFunding(deployment, f.witnesses, binding)).rejects.toThrow();
  });
  it('rejects a repeated or absent witness', async () => {
    const f = fixture();
    await expect(verifyUserActionFunding(deployment, [f.witnesses[0]], binding)).rejects.toThrow();
    await expect(
      verifyUserActionFunding(deployment, [f.witnesses[0], f.witnesses[0]], binding),
    ).rejects.toThrow();
  });
  it('bounds a stalled common-anchor read', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.first.getBlock.mockImplementation(async (height: unknown) =>
        height === 'finalized'
          ? { number: 200, hash: anchor }
          : Number(height) === 100
            ? { number: 100, hash }
            : new Promise(() => {}),
      );
      const result = expect(
        verifyUserActionFunding(deployment, f.witnesses, binding),
      ).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(10001);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });
});

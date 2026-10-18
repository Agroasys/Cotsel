import { Wallet } from 'ethers';
import {
  createUserActionExecutionScopeHash,
  USER_ACTION_IDS,
  type SettlementUserActionBinding,
} from '../../src/core/settlementUserActionBinding';
import type {
  GaslessUserAction,
  GaslessUserActionExecutionInput,
} from '../../src/core/gaslessExecutionTypes';
const buyer = new Wallet('0x' + '11'.repeat(32));
const supplier = new Wallet('0x' + '22'.repeat(32));
export async function createBoundUserActionFixture(
  action: GaslessUserAction = 'finalize_after_inspection_acceptance',
) {
  const signer = action === 'finalize_after_dispute_window' ? supplier : buyer;
  const escrow = '0x' + '33'.repeat(20),
    token = '0x' + '44'.repeat(20),
    deadline = '2000000000';
  const signature = await signer.signTypedData(
    { name: 'AgroasysEscrow', version: '1', chainId: '84532', verifyingContract: escrow },
    {
      UserActionAuthorization: [
        { name: 'user', type: 'address' },
        { name: 'action', type: 'uint8' },
        { name: 'tradeId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    { user: signer.address, action: USER_ACTION_IDS[action], tradeId: '7', nonce: '9', deadline },
  );
  const input: GaslessUserActionExecutionInput = {
    action,
    actionPackageId: 'package',
    sourceOperationId: 'operation',
    approvalScopeFingerprint: '0x' + 'a'.repeat(64),
    handoffId: 'handoff',
    chainId: 84532,
    contractAddress: escrow,
    expiresAt: new Date(Number(deadline) * 1000).toISOString(),
    payloadHash: '0x' + 'b'.repeat(64),
    userAddress: signer.address,
    tradeId: '7',
    userAuthorization: { nonce: '9', deadline, signature },
    requestId: 'request',
    sourceApiKeyId: 'owner',
  };
  const binding: SettlementUserActionBinding = {
    scopeVersion: 'agroasys.cotsel-user-action-binding.v1',
    ownerServiceId: 'owner',
    packageId: 'package',
    sourceOperationId: 'operation',
    approvalScopeFingerprint: input.approvalScopeFingerprint!,
    originalFundingFingerprint: 'c'.repeat(64),
    phase: 'gasless_user_action',
    action,
    signerRole: signer === buyer ? 'buyer' : 'supplier',
    signerAddress: signer.address.toLowerCase(),
    buyerAddress: buyer.address.toLowerCase(),
    supplierAddress: supplier.address.toLowerCase(),
    chainId: '84532',
    escrowAddress: escrow,
    tokenAddress: token,
    deploymentIdentity: `84532:${escrow}:${token}`,
    tradeId: '7',
    nonce: '9',
    deadline,
    expiresAt: input.expiresAt,
    recipient:
      action === 'open_dispute'
        ? null
        : action.includes('timeout')
          ? buyer.address.toLowerCase()
          : supplier.address.toLowerCase(),
    amount: action === 'open_dispute' ? '0' : action === 'cancel_locked_timeout' ? '1000' : '400',
    totalAmount: '1000',
    supplierSecondTranche: '400',
    fundingTransactionHash: '0x' + 'd'.repeat(64),
    fundingBlockNumber: '100',
    fundingBlockHash: '0x' + 'e'.repeat(64),
    executionScopeHash: createUserActionExecutionScopeHash(input),
  };
  return { input, binding, token };
}

import { validateBoundUserAction } from '../src/core/gaslessExecutionValidation';
import { createGaslessPayloadHash } from '../src/core/gaslessRequestNormalization';
import type { SettlementHandoffRecord } from '../src/core/settlementStore';
import { Wallet } from 'ethers';
import {
  assertUserActionMatchesBinding,
  createUserActionExecutionScopeHash,
  parseSettlementUserActionBinding,
  USER_ACTION_IDS,
  type SettlementUserActionBinding,
} from '../src/core/settlementUserActionBinding';
import {
  USER_ACTIONS,
  type GaslessUserAction,
  type GaslessUserActionExecutionInput,
} from '../src/core/gaslessExecutionTypes';
import { requireReviewedUserActionCapability } from '../src/core/gaslessExecutionValidation';
const buyer = new Wallet('0x' + '11'.repeat(32));
const supplier = new Wallet('0x' + '22'.repeat(32));
async function fixture(action: GaslessUserAction = 'finalize_after_inspection_acceptance') {
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
it.each(USER_ACTIONS)(
  'parses and verifies the distinct typed %s action without enabling execution',
  async (action) => {
    const { input, binding, token } = await fixture(action);
    expect(parseSettlementUserActionBinding(binding, 'owner')).toEqual(binding);
    expect(() => assertUserActionMatchesBinding(binding, input, token)).not.toThrow();
    expect(() => requireReviewedUserActionCapability()).toThrow(
      'settlement_client_upgrade_required',
    );
  },
);
it.each([
  'actionPackageId',
  'sourceOperationId',
  'approvalScopeFingerprint',
  'action',
  'chainId',
  'contractAddress',
  'expiresAt',
  'userAddress',
  'tradeId',
  'signature',
  'nonce',
  'deadline',
  'sourceApiKeyId',
] as const)('rejects independently altered request field %s', async (field) => {
  const { input, binding, token } = await fixture();
  if (field === 'signature' || field === 'nonce' || field === 'deadline')
    input.userAuthorization[field] = field === 'signature' ? '0x' + '00'.repeat(65) : '10';
  else if (field === 'chainId') input.chainId = 1;
  else if (field === 'action') input.action = 'cancel_locked_timeout';
  else
    input[field] =
      field === 'contractAddress' || field === 'userAddress' ? '0x' + '55'.repeat(20) : 'different';
  expect(() => assertUserActionMatchesBinding(binding, input, token)).toThrow();
});
it.each([
  'recipient',
  'amount',
  'signerRole',
  'originalFundingFingerprint',
  'deploymentIdentity',
  'fundingBlockHash',
  'nonce',
  'expiresAt',
] as const)('rejects malformed binding field %s', async (field) => {
  const { binding } = await fixture();
  const changed = { ...binding, [field]: 'invalid' };
  expect(() => parseSettlementUserActionBinding(changed, 'owner')).toThrow();
});
it('rejects absent owner, unknown fields, fractional expiry and a valid signature for a different action', async () => {
  const { input, binding, token } = await fixture();
  expect(() => parseSettlementUserActionBinding(binding, null)).toThrow();
  expect(() => parseSettlementUserActionBinding({ ...binding, extra: true }, 'owner')).toThrow();
  expect(() =>
    parseSettlementUserActionBinding(
      { ...binding, expiresAt: new Date(Date.parse(binding.expiresAt) + 1).toISOString() },
      'owner',
    ),
  ).toThrow();
  const other = await fixture('cancel_locked_timeout');
  input.userAuthorization.signature = other.input.userAuthorization.signature;
  binding.executionScopeHash = createUserActionExecutionScopeHash(input);
  expect(() => assertUserActionMatchesBinding(binding, input, token)).toThrow();
});

it('requires independent original funding after exact owned binding validation', async () => {
  const { input, binding, token } = await fixture();
  const { payloadHash: _hash, requestId: _request, sourceApiKeyId: _owner, ...hashable } = input;
  input.payloadHash = createGaslessPayloadHash(hashable);
  const handoff = {
    handoffId: input.handoffId,
    sourceApiKeyId: input.sourceApiKeyId,
    phase: 'gasless_user_action',
    settlementChannel: 'cotsel_escrow',
    tradeId: input.tradeId,
    externalReference: input.sourceOperationId,
    executionBinding: binding,
    executionStatus: 'pending',
  } as SettlementHandoffRecord;
  const verify = jest.fn().mockRejectedValue(new Error('funding unavailable'));
  await expect(validateBoundUserAction(input, async () => handoff, token, verify)).rejects.toThrow(
    'funding unavailable',
  );
  expect(verify).toHaveBeenCalledWith(binding);
  verify.mockClear();
  await expect(
    validateBoundUserAction({ ...input, tradeId: '8' }, async () => handoff, token, verify),
  ).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
  await expect(validateBoundUserAction(input, async () => handoff, token)).rejects.toThrow(
    'verifier is required',
  );
});

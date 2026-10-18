import { validateBoundUserAction } from '../src/core/gaslessExecutionValidation';
import { createGaslessPayloadHash } from '../src/core/gaslessRequestNormalization';
import type { SettlementHandoffRecord } from '../src/core/settlementStore';
import {
  assertUserActionMatchesBinding,
  createUserActionExecutionScopeHash,
  parseSettlementUserActionBinding,
} from '../src/core/settlementUserActionBinding';
import { USER_ACTIONS } from '../src/core/gaslessExecutionTypes';
import { createBoundUserActionFixture as fixture } from './helpers/boundUserActionFixture';
import { requireReviewedUserActionCapability } from '../src/core/gaslessExecutionValidation';

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

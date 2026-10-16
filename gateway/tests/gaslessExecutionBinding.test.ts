import { executionBindingFixture } from './helpers/settlementExecutionBindingFixtures';
import {
  createGaslessExecutionScopeHash,
  createGaslessPayloadHash,
  normalizeCreateTradeInput,
} from '../src/core/gaslessRequestNormalization';
import { assertHandoffMatchesExecution } from '../src/core/gaslessExecutionValidation';
import { buildCreateTradeInput } from './helpers/gaslessManagedSignerFixtures';

// Local boundary tests with unsigned fixture identities; not real provider acceptance.
describe('immutable gasless handoff execution binding', () => {
  function fixture() {
    const input = normalizeCreateTradeInput({
      ...buildCreateTradeInput('handoff-a', 'a'),
      sourceApiKeyId: 'service-a',
    });
    const handoff = {
      executionBinding: executionBindingFixture(
        input,
        'service-a',
        '0x0000000000000000000000000000000000000888',
      ),
      handoffId: input.handoffId,
      ricardianHash: input.ricardianHash,
      sourceApiKeyId: 'service-a',
      phase: 'gasless_create_trade',
      settlementChannel: 'cotsel_escrow',
      metadata: {
        executionScopeVersion: 'gasless_create_trade_scope_v1',
        executionScopeHash: createGaslessExecutionScopeHash(input),
      },
    };
    return { input, handoff };
  }
  test('accepts exactly the bound scope with new transport identifiers', () => {
    const { input, handoff } = fixture();
    expect(() =>
      assertHandoffMatchesExecution(
        handoff as never,
        { ...input, requestId: 'retry' },
        '0x0000000000000000000000000000000000000888',
      ),
    ).not.toThrow();
  });
  test.each([
    'buyerAddress',
    'supplierAddress',
    'chainId',
    'contractAddress',
    'expiresAt',
    'totalAmount',
    'logisticsAmount',
    'platformFeesAmount',
    'supplierFirstTranche',
    'supplierSecondTranche',
  ])('rejects changed %s with a fresh transport hash', (field) => {
    const { input, handoff } = fixture();
    const changed = { ...input, [field]: field === 'chainId' ? 1 : 'changed' };
    const {
      payloadHash: _payloadHash,
      requestId: _requestId,
      sourceApiKeyId: _sourceApiKeyId,
      ...hashable
    } = changed;
    changed.payloadHash = createGaslessPayloadHash(hashable);
    expect(() =>
      assertHandoffMatchesExecution(
        handoff as never,
        changed,
        '0x0000000000000000000000000000000000000888',
      ),
    ).toThrow('immutable typed handoff binding');
  });
  test.each(['buyerAuthorization', 'usdcAuthorization'])('rejects changed %s nonce', (field) => {
    const { input, handoff } = fixture();
    const changed = {
      ...input,
      [field]: { ...input[field as 'buyerAuthorization' | 'usdcAuthorization'], nonce: '1' },
    };
    expect(() =>
      assertHandoffMatchesExecution(
        handoff as never,
        changed,
        '0x0000000000000000000000000000000000000888',
      ),
    ).toThrow('immutable typed handoff binding');
  });
  test('rejects a different authenticated platform service', () => {
    const { input, handoff } = fixture();
    expect(() =>
      assertHandoffMatchesExecution(
        handoff as never,
        { ...input, sourceApiKeyId: 'service-b' },
        '0x0000000000000000000000000000000000000888',
      ),
    ).toThrow('issuing service identity');
  });
  test('rejects missing legacy bindings', () => {
    const { input, handoff } = fixture();
    expect(() =>
      assertHandoffMatchesExecution(
        { ...handoff, executionBinding: null, metadata: {} } as never,
        input,
        '0x0000000000000000000000000000000000000888',
      ),
    ).toThrow('immutable handoff scope');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGaslessNonceDriftError } from '../src/core/gaslessSettlementExecutionService';

describe('gasless relayer nonce drift handling', () => {
  it('classifies provider nonce drift errors as retryable relayer nonce drift', () => {
    expect(
      isGaslessNonceDriftError(
        Object.assign(new Error('nonce too low'), {
          code: 'NONCE_EXPIRED',
        }),
      ),
    ).toBe(true);
    expect(isGaslessNonceDriftError(new Error('nonce has already been used'))).toBe(true);
    expect(isGaslessNonceDriftError(new Error('replacement fee too low'))).toBe(true);
    expect(isGaslessNonceDriftError(new Error('execution reverted'))).toBe(false);
  });

  it('resets the nonce manager before sponsored create, user, and operator broadcasts', () => {
    const source = readFileSync(
      join(__dirname, '../src/core/gaslessSettlementExecutionService.ts'),
      'utf8',
    );

    expect(source).toContain('async function withFreshSignerNonce');
    expect(source).toMatch(/signer\.reset\(\);[\s\S]*return await operation\(\);/);
    expect(source).toContain(
      'withFreshSignerNonce(() =>\n        escrow.createTradeWithAuthorization',
    );
    expect(source).toContain('withFreshSignerNonce(() =>\n        broadcastUserAction');
    expect(source).toContain(
      'withFreshSignerNonce(() =>\n        escrow.finalizeAfterDisputeWindow',
    );
  });
});

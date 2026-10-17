import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('gasless relayer nonce safety', () => {
  it('signs once and routes every raw transaction through persisted broadcast identity', () => {
    const source = readFileSync(
      join(__dirname, '../src/core/gaslessRawPrivateKeyExecutor.ts'),
      'utf8',
    );

    expect(source).not.toContain('NonceManager');
    expect(source).not.toContain('withFreshSignerNonce');
    expect(source).not.toContain('signer.reset()');
    expect(source).toContain('const signedTransaction = await signer.signTransaction(transaction)');
    expect(source).toContain('return broadcastPersistedGaslessTransaction(');
    // Only create-trade and direct USDC transfer remain executable in the compatibility release.
    expect(source.match(/await signAndBroadcast\(/g)).toHaveLength(2);
  });
});

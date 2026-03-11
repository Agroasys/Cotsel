import { FallbackProvider, JsonRpcProvider } from 'ethers';
import { createManagedRpcProvider } from '../src/rpc/failoverProvider';

describe('managed RPC provider helper', () => {
  test('returns a plain JsonRpcProvider when no fallback URLs are configured', () => {
    const provider = createManagedRpcProvider('http://127.0.0.1:8545');
    expect(provider).toBeInstanceOf(JsonRpcProvider);
  });

  test('returns a FallbackProvider when fallback URLs are configured', () => {
    const provider = createManagedRpcProvider('http://127.0.0.1:8545', [
      'http://127.0.0.1:8546',
      'http://127.0.0.1:8547',
    ]);

    expect(provider).toBeInstanceOf(FallbackProvider);
    expect((provider as FallbackProvider).providerConfigs).toHaveLength(3);
  });

  test('deduplicates repeated RPC URLs', () => {
    const provider = createManagedRpcProvider('http://127.0.0.1:8545', [
      'http://127.0.0.1:8545',
      'http://127.0.0.1:8546',
    ]);

    expect((provider as FallbackProvider).providerConfigs).toHaveLength(2);
  });
});

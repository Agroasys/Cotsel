import {
  buildExplorerTxUrl,
  getBaseSettlementRuntime,
  listBaseSettlementRuntimes,
  resolveSettlementRuntime,
} from '../src/runtime';

describe('settlement runtime registry', () => {
  test('lists the active Base runtimes', () => {
    expect(listBaseSettlementRuntimes().map((runtime) => runtime.key)).toEqual([
      'base-sepolia',
      'base-mainnet',
    ]);
  });

  test('resolves Base Sepolia defaults from runtime key', () => {
    const runtime = resolveSettlementRuntime({
      runtimeKey: 'base-sepolia',
      escrowAddress: '0x0000000000000000000000000000000000000001',
    });

    expect(runtime).toMatchObject({
      runtimeKey: 'base-sepolia',
      networkName: 'Base Sepolia',
      chainId: 84532,
      rpcUrl: 'https://sepolia.base.org',
      explorerBaseUrl: 'https://sepolia-explorer.base.org/tx/',
      escrowAddress: '0x0000000000000000000000000000000000000001',
      usdcAddress: getBaseSettlementRuntime('base-sepolia').usdcAddress,
    });
  });

  test('infers Base runtime from known chain id', () => {
    const runtime = resolveSettlementRuntime({
      chainId: 8453,
      rpcUrl: 'https://rpc.example.com/base',
      escrowAddress: '0x0000000000000000000000000000000000000002',
    });

    expect(runtime.runtimeKey).toBe('base-mainnet');
    expect(runtime.networkName).toBe('Base Mainnet');
    expect(runtime.rpcUrl).toBe('https://rpc.example.com/base');
  });

  test('falls back to explicit custom runtime for local/test chains', () => {
    const runtime = resolveSettlementRuntime({
      chainId: 31337,
      rpcUrl: 'http://127.0.0.1:8545',
      rpcFallbackUrls: ['http://127.0.0.1:8545', 'http://127.0.0.1:8546'],
      explorerBaseUrl: 'http://127.0.0.1:8545',
      escrowAddress: '0x0000000000000000000000000000000000000003',
      usdcAddress: '0x0000000000000000000000000000000000000004',
    });

    expect(runtime).toMatchObject({
      runtimeKey: 'custom',
      networkName: 'Custom (31337)',
      chainId: 31337,
      rpcUrl: 'http://127.0.0.1:8545',
      rpcFallbackUrls: ['http://127.0.0.1:8545', 'http://127.0.0.1:8546'],
      explorerBaseUrl: 'http://127.0.0.1:8545/tx/',
      escrowAddress: '0x0000000000000000000000000000000000000003',
      usdcAddress: '0x0000000000000000000000000000000000000004',
    });
  });

  test('builds explorer tx urls from canonical explorer base', () => {
    expect(buildExplorerTxUrl('https://base.blockscout.com', '0xabc')).toBe(
      'https://base.blockscout.com/tx/0xabc',
    );
    expect(buildExplorerTxUrl('https://base.blockscout.com/tx/', '0xabc')).toBe(
      'https://base.blockscout.com/tx/0xabc',
    );
  });
});

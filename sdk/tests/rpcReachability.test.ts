import { createServer, type Server } from 'node:http';
import {
  assertRpcEndpointReachable,
  assertRpcEndpointsReachable,
  selectReachableRpcEndpoint,
} from '../src/rpc/reachability';

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function rpcServer(chainId: string): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: chainId }));
  });
}

describe('RPC startup reachability', () => {
  test('accepts the expected chain', async () => {
    const server = rpcServer('0x14a34');
    const url = await listen(server);
    try {
      await expect(
        assertRpcEndpointReachable(url, { expectedChainId: 84532 }),
      ).resolves.toBeUndefined();
    } finally {
      await close(server);
    }
  });

  test('rejects a reachable endpoint on the wrong chain without exposing its path', async () => {
    const server = rpcServer('0x1');
    const baseUrl = await listen(server);
    const url = `${baseUrl}/v3/private-provider-key`;
    try {
      await expect(assertRpcEndpointReachable(url, { expectedChainId: 84532 })).rejects.toThrow(
        'Wrong chain: expected 84532, received 1',
      );
      await expect(assertRpcEndpointReachable(url, { expectedChainId: 84532 })).rejects.not.toThrow(
        'private-provider-key',
      );
    } finally {
      await close(server);
    }
  });

  test('fails closed when any configured endpoint returns the wrong chain', async () => {
    const primary = rpcServer('0x1');
    const fallback = rpcServer('0x14a34');
    const primaryUrl = await listen(primary);
    const fallbackUrl = await listen(fallback);
    try {
      await expect(
        assertRpcEndpointsReachable([primaryUrl, fallbackUrl], { expectedChainId: 84532 }),
      ).rejects.toThrow('Wrong chain: expected 84532, received 1');
    } finally {
      await close(primary);
      await close(fallback);
    }
  });

  test('uses a correct-chain fallback when the primary is unavailable', async () => {
    const fallback = rpcServer('0x14a34');
    const fallbackUrl = await listen(fallback);
    const unreachablePrimaryUrl = 'http://127.0.0.1:1';
    try {
      await expect(
        assertRpcEndpointsReachable([unreachablePrimaryUrl, fallbackUrl], {
          expectedChainId: 84532,
          timeoutMs: 300,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await close(fallback);
    }
  });

  test('fails closed when a healthy primary masks a wrong-chain fallback', async () => {
    const primary = rpcServer('0x14a34');
    const fallback = rpcServer('0x1');
    const primaryUrl = await listen(primary);
    const fallbackUrl = await listen(fallback);
    try {
      await expect(
        selectReachableRpcEndpoint([primaryUrl, fallbackUrl], { expectedChainId: 84532 }),
      ).rejects.toThrow('Wrong chain: expected 84532, received 1');
    } finally {
      await close(primary);
      await close(fallback);
    }
  });
});

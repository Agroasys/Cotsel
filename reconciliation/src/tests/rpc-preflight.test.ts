import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { assertRpcEndpointReachable, redactRpcUrlForLogs } from '../blockchain/rpc-preflight';

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

test('fails fast with clear message when RPC endpoint is unavailable at startup', async () => {
  const server = net.createServer();
  await listen(server);

  const address = server.address();
  assert(address && typeof address !== 'string', 'expected tcp server address');
  const rpcUrl = `http://127.0.0.1:${address.port}`;

  await close(server);

  await assert.rejects(
    () => assertRpcEndpointReachable(rpcUrl, 300),
    /RPC endpoint is not reachable at startup/,
  );
});

test('redacts credentials and query data from RPC URL logs', () => {
  const redacted = redactRpcUrlForLogs('https://user:secret@example.com/v2/token?apiKey=my-secret');
  assert.equal(redacted, 'https://example.com');
});

test('startup RPC failure messages do not leak RPC credentials', async () => {
  const server = net.createServer();
  await listen(server);

  const address = server.address();
  assert(address && typeof address !== 'string', 'expected tcp server address');
  const rpcUrl = `http://user:secret@127.0.0.1:${address.port}/v2/token?apiKey=my-secret`;

  await close(server);

  await assert.rejects(
    () => assertRpcEndpointReachable(rpcUrl, 300),
    (error: unknown) => {
      assert(error instanceof Error, 'expected startup validation to throw an Error');
      assert.match(error.message, /RPC endpoint is not reachable at startup/);
      assert.match(error.message, new RegExp(`RPC_URL=http:\\/\\/127.0.0.1:${address.port}`));
      assert.doesNotMatch(error.message, /secret/);
      assert.doesNotMatch(error.message, /apiKey=my-secret/);
      assert.doesNotMatch(error.message, /\/v2\/token/);
      return true;
    },
  );
});

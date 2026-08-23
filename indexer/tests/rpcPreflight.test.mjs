import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { selectReachableRpcEndpoint } from '../lib/rpc-preflight.js';

function listen(server) {
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

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function rpcServer({ chainId = '0x14a34', blockNumber = '0x64', blockError = null } = {}) {
  return createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body);
      let result;

      if (payload.method === 'eth_chainId') {
        result = chainId;
      } else if (payload.method === 'eth_blockNumber') {
        result = blockNumber;
      } else if (payload.method === 'eth_getBlockByNumber') {
        if (blockError) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: blockError }));
          return;
        }
        result = { number: payload.params[0], hash: `0x${'1'.repeat(64)}` };
      } else {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end();
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    });
  });
}

test('selects the correct-chain fallback after a wrong-chain primary', async () => {
  const primary = rpcServer({ chainId: '0x1' });
  const fallback = rpcServer();
  const primaryUrl = await listen(primary);
  const fallbackUrl = await listen(fallback);
  try {
    const selection = await selectReachableRpcEndpoint([primaryUrl, fallbackUrl], 84532, 300);
    assert.equal(selection.url, fallbackUrl);
    assert.equal(selection.checked, 2);
    assert.equal(selection.reachable, true);
  } finally {
    await close(primary);
    await close(fallback);
  }
});

test('selects the fallback when the primary cannot serve block data', async () => {
  const primary = rpcServer({
    blockError: { code: -32001, message: 'resource not found' },
  });
  const fallback = rpcServer();
  const primaryUrl = await listen(primary);
  const fallbackUrl = await listen(fallback);
  try {
    const selection = await selectReachableRpcEndpoint([primaryUrl, fallbackUrl], 84532, 300);
    assert.equal(selection.url, fallbackUrl);
    assert.equal(selection.checked, 2);
    assert.equal(selection.reachable, true);
  } finally {
    await close(primary);
    await close(fallback);
  }
});

test('fails closed when every endpoint is unavailable or on the wrong chain', async () => {
  const wrongChain = rpcServer({ chainId: '0x1' });
  const wrongChainUrl = await listen(wrongChain);
  try {
    await assert.rejects(
      () => selectReachableRpcEndpoint([wrongChainUrl], 84532, 300),
      /No configured RPC endpoint returned expected chain ID 84532/,
    );
  } finally {
    await close(wrongChain);
  }
});

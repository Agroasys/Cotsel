import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { callRpc, selectReachableRpcEndpoint } from '../lib/rpc-preflight.js';

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

function rpcServer({
  chainId = '0x14a34',
  blockNumber = '0x64',
  blockError = null,
  codeStatus = 200,
} = {}) {
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
      } else if (payload.method === 'eth_getCode') {
        const status = typeof codeStatus === 'function' ? codeStatus() : codeStatus;
        if (status !== 200) {
          response.writeHead(status, { 'retry-after': '0' });
          response.end();
          return;
        }
        result = '0x6000';
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

test('fails closed when any configured endpoint returns the wrong chain', async () => {
  const primary = rpcServer({ chainId: '0x1' });
  const fallback = rpcServer();
  const primaryUrl = await listen(primary);
  const fallbackUrl = await listen(fallback);
  try {
    await assert.rejects(
      () => selectReachableRpcEndpoint([primaryUrl, fallbackUrl], 84532, 300),
      /Wrong chain: expected 84532, received 1/,
    );
  } finally {
    await close(primary);
    await close(fallback);
  }
});

test('fails closed when a healthy primary masks a wrong-chain fallback', async () => {
  const primary = rpcServer();
  const fallback = rpcServer({ chainId: '0x1' });
  const primaryUrl = await listen(primary);
  const fallbackUrl = await listen(fallback);
  try {
    await assert.rejects(
      () => selectReachableRpcEndpoint([primaryUrl, fallbackUrl], 84532, 300),
      /Wrong chain: expected 84532, received 1/,
    );
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
      /Wrong chain: expected 84532, received 1/,
    );
  } finally {
    await close(wrongChain);
  }
});

test('retries a transient rate limit while keeping the same verified endpoint', async () => {
  let calls = 0;
  const server = rpcServer({ codeStatus: () => (++calls === 1 ? 429 : 200) });
  const url = await listen(server);
  try {
    assert.equal(await callRpc(url, 'eth_getCode', ['0x00', 'latest'], 300), '0x6000');
    assert.equal(calls, 2);
  } finally {
    await close(server);
  }
});

test('a rate limit during contract verification selects a fully checked fallback', async () => {
  const primary = rpcServer({ codeStatus: 429 });
  const fallback = rpcServer();
  const urls = [await listen(primary), await listen(fallback)];
  const checked = [];
  try {
    const selection = await selectReachableRpcEndpoint(urls, 84532, 300, async (url) => {
      checked.push(url);
      assert.equal(await callRpc(url, 'eth_getCode', ['0x00', 'latest'], 300), '0x6000');
    });
    assert.equal(selection.url, urls[1]);
    assert.deepEqual(checked, urls);
  } finally {
    await close(primary);
    await close(fallback);
  }
});

test('semantic verification failures cannot be hidden by a fallback', async () => {
  const primary = rpcServer();
  const fallback = rpcServer();
  const urls = [await listen(primary), await listen(fallback)];
  let calls = 0;
  try {
    await assert.rejects(
      () =>
        selectReachableRpcEndpoint(urls, 84532, 300, async () => {
          calls++;
          throw new Error('Contract codehash mismatch');
        }),
      /Contract codehash mismatch/,
    );
    assert.equal(calls, 1);
  } finally {
    await close(primary);
    await close(fallback);
  }
});

test('rate-limit retries are bounded and authentication failures are not retried', async () => {
  for (const [status, expectedCalls] of [
    [429, 3],
    [401, 1],
  ]) {
    let calls = 0;
    const server = rpcServer({
      codeStatus: () => {
        calls++;
        return status;
      },
    });
    const url = await listen(server);
    try {
      await assert.rejects(
        () => callRpc(url, 'eth_getCode', ['0x00', 'latest'], 300),
        new RegExp(`HTTP ${status}`),
      );
      assert.equal(calls, expectedCalls);
    } finally {
      await close(server);
    }
  }
});

test('Retry-After shares the original call timeout and cannot trigger an early retry', async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    calls++;
    response.writeHead(429, { 'retry-after': '2' });
    response.end();
  });
  const url = await listen(server);
  try {
    await assert.rejects(() => callRpc(url, 'eth_getCode', [], 100), /RPC request timed out/);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test('a response-body disconnect stays a transport error and can select a fallback', async () => {
  const primary = rpcServer();
  const fallback = rpcServer();
  const urls = [await listen(primary), await listen(fallback)];
  const originalFetch = globalThis.fetch;
  const validated = [];
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    if (url === urls[0] && request.method === 'eth_getCode') {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      );
    }
    return originalFetch(url, options);
  };
  try {
    const result = await selectReachableRpcEndpoint(urls, 84532, 100, async (url) => {
      validated.push(url);
      await callRpc(url, 'eth_getCode', [], 100);
    });
    assert.equal(result.url, urls[1]);
    assert.deepEqual(validated, urls);
  } finally {
    globalThis.fetch = originalFetch;
    await close(primary);
    await close(fallback);
  }
});

test('malformed JSON remains fatal and is not mistaken for a connection failure', async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{invalid');
  });
  const url = await listen(server);
  try {
    await assert.rejects(() => callRpc(url, 'eth_getCode', [], 300), SyntaxError);
  } finally {
    await close(server);
  }
});

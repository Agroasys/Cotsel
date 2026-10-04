import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  assertCheckpointOnChain,
  assertFinalitySupport,
  ChainReadinessError,
  checkpointLagBlocks,
  createIndexerReadinessCheck,
  readProcessorCheckpoint,
} from '../lib/chainReadiness.js';
import { createProbeServer } from '../lib/probeServer.js';

const CHAIN_ID = 84532;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

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

/**
 * `blocks` maps a block tag or hex height to the header returned by
 * `eth_getBlockByNumber`; a missing entry answers `null`, an Error answers a
 * JSON-RPC error.
 */
function rpcServer({ chainId = `0x${CHAIN_ID.toString(16)}`, head = 1000, blocks = {} } = {}) {
  return createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body);
      const reply = (fields) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, ...fields }));
      };

      if (payload.method === 'eth_chainId') {
        reply({ result: chainId });
      } else if (payload.method === 'eth_blockNumber') {
        reply({ result: `0x${head.toString(16)}` });
      } else if (payload.method === 'eth_getBlockByNumber') {
        const block = blocks[payload.params[0]];
        if (block instanceof Error) {
          reply({ error: { code: -32602, message: block.message } });
        } else {
          reply({ result: block ?? null });
        }
      } else {
        reply({ error: { code: -32601, message: 'method not found' } });
      }
    });
  });
}

async function withRpc(options, run) {
  const server = rpcServer(options);
  const url = await listen(server);
  try {
    return await run(url);
  } finally {
    await close(server);
  }
}

function header(number, hash = HASH_A) {
  return { number: `0x${number.toString(16)}`, hash };
}

test('finality preflight accepts an endpoint that serves the finalized tag', async () => {
  await withRpc({ head: 1000, blocks: { finalized: header(990) } }, async (url) => {
    const result = await assertFinalitySupport(url);
    assert.equal(result.finalizedBlock, 990n);
    assert.equal(result.head, 1000n);
  });
});

test('finality preflight fails startup when the finalized tag is unsupported', async () => {
  await withRpc({ blocks: { finalized: new Error('invalid block tag') } }, async (url) => {
    await assert.rejects(assertFinalitySupport(url), ChainReadinessError);
  });
  await withRpc({ blocks: {} }, async (url) => {
    await assert.rejects(assertFinalitySupport(url), /no finalized block/);
  });
});

test('finality preflight rejects a finalized block ahead of the head', async () => {
  await withRpc({ head: 100, blocks: { finalized: header(200) } }, async (url) => {
    await assert.rejects(assertFinalitySupport(url), /ahead of chain head/);
  });
});

test('checkpoint preflight passes a fresh database and an initial checkpoint', async () => {
  await withRpc({}, async (url) => {
    assert.equal(
      await assertCheckpointOnChain({ rpcUrl: url, checkpoint: null, startBlock: 10 }),
      'none',
    );
    assert.equal(
      await assertCheckpointOnChain({
        rpcUrl: url,
        checkpoint: { height: 500, hash: '0x' },
        startBlock: 10,
      }),
      'none',
    );
    assert.equal(
      await assertCheckpointOnChain({
        rpcUrl: url,
        checkpoint: { height: 9, hash: HASH_A },
        startBlock: 10,
      }),
      'none',
    );
  });
});

test('checkpoint preflight verifies a stored checkpoint against the chain', async () => {
  await withRpc({ blocks: { '0x1f4': header(500, HASH_A) } }, async (url) => {
    assert.equal(
      await assertCheckpointOnChain({
        rpcUrl: url,
        checkpoint: { height: 500, hash: HASH_A.toUpperCase().replace('0X', '0x') },
        startBlock: 10,
      }),
      'verified',
    );
  });
});

test('checkpoint preflight fails startup on a checkpoint from another chain or fork', async () => {
  await withRpc({ blocks: { '0x1f4': header(500, HASH_B) } }, async (url) => {
    await assert.rejects(
      assertCheckpointOnChain({
        rpcUrl: url,
        checkpoint: { height: 500, hash: HASH_A },
        startBlock: 10,
      }),
      /hash does not match the chain/,
    );
  });
  await withRpc({ head: 100, blocks: {} }, async (url) => {
    await assert.rejects(
      assertCheckpointOnChain({
        rpcUrl: url,
        checkpoint: { height: 500, hash: HASH_A },
        startBlock: 10,
      }),
      /ahead of the chain/,
    );
  });
});

test('reads the processor checkpoint row', async () => {
  const empty = { query: async () => ({ rows: [] }) };
  assert.equal(await readProcessorCheckpoint(empty), null);

  let sql = '';
  const stored = {
    query: async (text) => {
      sql = text;
      return { rows: [{ height: '42', hash: HASH_A }] };
    },
  };
  assert.deepEqual(await readProcessorCheckpoint(stored), { height: 42, hash: HASH_A });
  assert.match(sql, /squid_processor\.status WHERE id = 0/);
});

test('checkpoint lag excludes the configured confirmations and never goes negative', () => {
  assert.equal(checkpointLagBlocks(1000n, 990, 10), 0n);
  assert.equal(checkpointLagBlocks(1000n, 800, 10), 190n);
  assert.equal(checkpointLagBlocks(1000n, 999, 10), 0n);
});

// A chain whose block 985 matches the default checkpoint below.
const CHAIN = { head: 1000, blocks: { '0x3d9': header(985, HASH_A) } };

function readinessDeps(url, overrides = {}) {
  return {
    startupComplete: () => true,
    rpcUrl: () => url,
    chainId: CHAIN_ID,
    readCheckpoint: async () => ({ height: 985, hash: HASH_A }),
    countUnresolvedQuarantine: async () => 0,
    finalityConfirmationBlocks: 10,
    maxCheckpointLagBlocks: 20,
    startBlock: 10,
    rpcTimeoutMs: 1000,
    ...overrides,
  };
}

function statusOf(result, name) {
  return result.dependencies.find((dependency) => dependency.name === name)?.status;
}

test('readiness is green when every dependency is safe', async () => {
  await withRpc(CHAIN, async (url) => {
    const result = await createIndexerReadinessCheck(readinessDeps(url))();
    assert.equal(result.ready, true);
    assert.deepEqual(
      result.dependencies.map((dependency) => [dependency.name, dependency.status]),
      [
        ['startup-preflight', 'ok'],
        ['chain-rpc', 'ok'],
        ['quarantine', 'ok'],
        ['checkpoint-freshness', 'ok'],
        ['checkpoint-on-chain', 'ok'],
      ],
    );
  });
});

test('readiness stays red until startup gates pass', async () => {
  await withRpc(CHAIN, async (url) => {
    const result = await createIndexerReadinessCheck(
      readinessDeps(url, { startupComplete: () => false }),
    )();
    assert.equal(result.ready, false);
    assert.equal(statusOf(result, 'startup-preflight'), 'unavailable');
  });
});

test('a stale checkpoint fails readiness', async () => {
  await withRpc(CHAIN, async (url) => {
    const result = await createIndexerReadinessCheck(
      readinessDeps(url, { readCheckpoint: async () => ({ height: 900, hash: HASH_A }) }),
    )();
    assert.equal(result.ready, false);
    assert.equal(statusOf(result, 'checkpoint-freshness'), 'unavailable');
    assert.equal(statusOf(result, 'chain-rpc'), 'ok');
  });
});

test('a missing checkpoint fails readiness', async () => {
  await withRpc(CHAIN, async (url) => {
    const result = await createIndexerReadinessCheck(
      readinessDeps(url, { readCheckpoint: async () => null }),
    )();
    assert.equal(statusOf(result, 'checkpoint-freshness'), 'unavailable');
  });
});

test('a same-height checkpoint from another fork fails readiness after startup', async () => {
  await withRpc({ head: 1000, blocks: { '0x3d9': header(985, HASH_B) } }, async (url) => {
    const result = await createIndexerReadinessCheck(readinessDeps(url))();
    assert.equal(result.ready, false);
    assert.equal(statusOf(result, 'startup-preflight'), 'ok');
    assert.equal(statusOf(result, 'checkpoint-freshness'), 'ok');
    assert.equal(statusOf(result, 'checkpoint-on-chain'), 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /hash does not match/);
  });
});

test('an initial checkpoint is not mistaken for fork drift', async () => {
  await withRpc(CHAIN, async (url) => {
    const result = await createIndexerReadinessCheck(
      readinessDeps(url, { readCheckpoint: async () => ({ height: 985, hash: '0x' }) }),
    )();
    assert.equal(statusOf(result, 'checkpoint-on-chain'), 'ok');
  });
});

test('a dead RPC fails readiness without leaking the endpoint', async () => {
  const server = rpcServer();
  const url = await listen(server);
  await close(server);

  const result = await createIndexerReadinessCheck(readinessDeps(url))();
  assert.equal(result.ready, false);
  assert.equal(statusOf(result, 'chain-rpc'), 'unavailable');
  assert.equal(statusOf(result, 'checkpoint-freshness'), 'unavailable');
  assert.equal(statusOf(result, 'checkpoint-on-chain'), 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1/);
});

test('an RPC that switched chains fails readiness', async () => {
  await withRpc({ chainId: '0x1', head: 1000 }, async (url) => {
    const result = await createIndexerReadinessCheck(readinessDeps(url))();
    assert.equal(statusOf(result, 'chain-rpc'), 'unavailable');
  });
});

test('an unresolved quarantine or unreachable database fails readiness', async () => {
  await withRpc(CHAIN, async (url) => {
    const quarantined = await createIndexerReadinessCheck(
      readinessDeps(url, { countUnresolvedQuarantine: async () => 2 }),
    )();
    assert.equal(statusOf(quarantined, 'quarantine'), 'unavailable');

    const databaseDown = await createIndexerReadinessCheck(
      readinessDeps(url, {
        countUnresolvedQuarantine: async () => {
          throw new Error('connect ECONNREFUSED db.internal:5432 user=cotsel_indexer_app');
        },
      }),
    )();
    assert.equal(statusOf(databaseDown, 'quarantine'), 'unavailable');
    assert.doesNotMatch(JSON.stringify(databaseDown), /ECONNREFUSED|cotsel_indexer_app/);
  });
});

test('probe server keeps liveness green while readiness is red', async () => {
  const server = createProbeServer({
    readiness: async () => ({
      ready: false,
      dependencies: [{ name: 'chain-rpc', required: true, status: 'unavailable', durationMs: 1 }],
    }),
  });
  const base = await listen(server);
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'indexer' });

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).ready, false);

    assert.equal((await fetch(`${base}/graphql`)).status, 404);
    assert.equal((await fetch(`${base}/ready`, { method: 'POST' })).status, 405);
  } finally {
    await close(server);
  }
});

test('probe server reports ready and fails closed when the check throws', async () => {
  let throwing = false;
  const server = createProbeServer({
    readiness: async () => {
      if (throwing) {
        throw new Error('boom');
      }
      return { ready: true, dependencies: [] };
    },
  });
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    throwing = true;
    const failed = await fetch(`${base}/ready`);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /boom/);
  } finally {
    await close(server);
  }
});

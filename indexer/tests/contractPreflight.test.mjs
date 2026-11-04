import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { keccak256 } from 'ethers';

import {
  assertContractPreflight,
  assertDeploymentPins,
  assertNoUnresolvedQuarantine,
  ContractPreflightError,
  ESCROW_ABI_FINGERPRINT,
  MissingDeploymentPinError,
  UnresolvedQuarantineError,
} from '../lib/preflight.js';

const CONTRACT = '0x00000000000000000000000000000000000000aa';
const CODE = '0x60806040';
const CODEHASH = keccak256(CODE);

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
 * `latestCode` answers `eth_getCode` at "latest"; `startBlockCode` answers any
 * historical tag. `startBlockError` models a pruned or non-archive endpoint.
 */
function rpcServer({
  blockNumber = '0x3e8',
  latestCode = CODE,
  startBlockCode = CODE,
  startBlockError = null,
} = {}) {
  return createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });

      if (payload.method === 'eth_blockNumber') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: blockNumber }));
        return;
      }

      if (payload.method === 'eth_getCode') {
        const [, blockTag] = payload.params;
        if (blockTag === 'latest') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: latestCode }));
          return;
        }
        if (startBlockError) {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: startBlockError }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: startBlockCode }));
        return;
      }

      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
    });
  });
}

async function withRpc(options, fn) {
  const server = rpcServer(options);
  const url = await listen(server);
  try {
    return await fn(url);
  } finally {
    await close(server);
  }
}

function input(rpcUrl, overrides = {}) {
  return {
    rpcUrl,
    contractAddress: CONTRACT,
    startBlock: 100,
    timeoutMs: 2000,
    ...overrides,
  };
}

test('preflight passes and reports the codehash and ABI fingerprint', async () => {
  await withRpc({}, async (url) => {
    const result = await assertContractPreflight(input(url, { expectedCodehash: CODEHASH }));

    assert.equal(result.codehash, CODEHASH);
    assert.equal(result.abiFingerprint, ESCROW_ABI_FINGERPRINT);
    assert.equal(result.startBlockVerified, true);
  });
});

test('the ABI fingerprint is a stable sha256 digest of the event set', () => {
  assert.match(ESCROW_ABI_FINGERPRINT, /^[0-9a-f]{64}$/);
});

test('ABI drift fails before any RPC call is made', async () => {
  await assert.rejects(
    () =>
      assertContractPreflight(
        input('http://127.0.0.1:1', { expectedAbiFingerprint: 'c'.repeat(64) }),
      ),
    (error) => {
      assert.ok(error instanceof ContractPreflightError);
      assert.match(error.message, /ABI fingerprint drift/);
      return true;
    },
  );
});

test('an address with no contract code fails closed', async () => {
  await withRpc({ latestCode: '0x' }, async (url) => {
    await assert.rejects(
      () => assertContractPreflight(input(url)),
      /No contract code at 0x00000000000000000000000000000000000000aa/,
    );
  });
});

test('a redeployed contract is caught by the pinned codehash', async () => {
  await withRpc({ latestCode: '0xfeed' }, async (url) => {
    await assert.rejects(
      () => assertContractPreflight(input(url, { expectedCodehash: CODEHASH })),
      /Contract codehash mismatch/,
    );
  });
});

test('a start block ahead of the chain head fails closed', async () => {
  await withRpc({ blockNumber: '0x10' }, async (url) => {
    await assert.rejects(
      () => assertContractPreflight(input(url, { startBlock: 5000 })),
      /is ahead of chain head 16/,
    );
  });
});

test('a start block before the deployment fails closed', async () => {
  await withRpc({ startBlockCode: '0x' }, async (url) => {
    await assert.rejects(
      () => assertContractPreflight(input(url)),
      /would skip its own deployment history/,
    );
  });
});

test('a non-archive endpoint warns instead of blocking startup', async () => {
  await withRpc(
    { startBlockError: { code: -32000, message: 'missing trie node' } },
    async (url) => {
      const warnings = [];
      const result = await assertContractPreflight(input(url), {
        warn: (message, meta) => warnings.push({ message, meta }),
      });

      assert.equal(result.startBlockVerified, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0].message, /Could not verify contract code at START_BLOCK/);
      // The RPC URL must never reach a log line unredacted.
      assert.equal(warnings[0].meta.rpcUrl, new URL(url).origin);
    },
  );
});

test('the historical check can be turned off for a non-archive endpoint', async () => {
  await withRpc({ startBlockCode: '0x' }, async (url) => {
    const result = await assertContractPreflight(input(url, { verifyStartBlockCode: false }));
    assert.equal(result.startBlockVerified, false);
  });
});

test('startup proceeds when nothing is quarantined', async () => {
  let alerted = false;
  await assertNoUnresolvedQuarantine({
    quarantine: { countUnresolved: async () => 0 },
    alerts: {
      unresolvedQuarantineOnStartup: async () => {
        alerted = true;
      },
    },
    logger: { error: () => {} },
  });

  assert.equal(alerted, false);
});

test('startup is blocked and alerted while a quarantined log is unresolved', async () => {
  const alerts = [];
  const logged = [];

  await assert.rejects(
    () =>
      assertNoUnresolvedQuarantine({
        quarantine: { countUnresolved: async () => 2 },
        alerts: {
          unresolvedQuarantineOnStartup: async (count) => alerts.push(count),
        },
        logger: { error: (message, meta) => logged.push({ message, meta }) },
      }),
    (error) => {
      assert.ok(error instanceof UnresolvedQuarantineError);
      assert.equal(error.unresolvedCount, 2);
      return true;
    },
  );

  assert.deepEqual(alerts, [2]);
  assert.equal(logged.length, 1);
});

test('an alert failure cannot soften the startup gate', async () => {
  await assert.rejects(
    () =>
      assertNoUnresolvedQuarantine({
        quarantine: { countUnresolved: async () => 1 },
        alerts: {
          unresolvedQuarantineOnStartup: async () => {
            throw new Error('webhook down');
          },
        },
        logger: { error: () => {} },
      }),
    UnresolvedQuarantineError,
  );
});

const PINNED = {
  expectedContractCodehash: `0x${'ab'.repeat(32)}`,
  expectedAbiFingerprint: 'c'.repeat(64),
  notificationsEnabled: true,
  notificationsWebhookUrl: 'https://alerts.example.invalid/hook',
};

test('a local profile may run without reviewed pins', () => {
  assertDeploymentPins({
    profile: 'local',
    expectedContractCodehash: null,
    expectedAbiFingerprint: null,
    notificationsEnabled: false,
    notificationsWebhookUrl: null,
  });
});

test('a fully pinned deployed profile starts', () => {
  assertDeploymentPins({ profile: 'staging', ...PINNED });
  assertDeploymentPins({ profile: 'production', ...PINNED });
});

test('a deployed profile without a pinned codehash fails closed', () => {
  // Otherwise the preflight degrades to "is there any code at this address",
  // and a redeploy at the same address starts cleanly.
  assert.throws(
    () =>
      assertDeploymentPins({
        profile: 'staging',
        ...PINNED,
        expectedContractCodehash: null,
      }),
    (error) => {
      assert.ok(error instanceof MissingDeploymentPinError);
      assert.deepEqual(error.missing, ['EXPECTED_CONTRACT_CODEHASH']);
      return true;
    },
  );
});

test('a deployed profile without a pinned ABI fingerprint fails closed', () => {
  assert.throws(
    () => assertDeploymentPins({ profile: 'production', ...PINNED, expectedAbiFingerprint: null }),
    /EXPECTED_ABI_FINGERPRINT/,
  );
});

test('a deployed profile that cannot page anyone fails closed', () => {
  // A poison log holds the checkpoint; without a webhook it holds silently.
  assert.throws(
    () => assertDeploymentPins({ profile: 'staging', ...PINNED, notificationsEnabled: false }),
    /NOTIFICATIONS_ENABLED=true/,
  );

  assert.throws(
    () => assertDeploymentPins({ profile: 'staging', ...PINNED, notificationsWebhookUrl: null }),
    /NOTIFICATIONS_WEBHOOK_URL/,
  );
});

test('every missing control is reported at once, not one restart at a time', () => {
  assert.throws(
    () =>
      assertDeploymentPins({
        profile: 'staging',
        expectedContractCodehash: null,
        expectedAbiFingerprint: null,
        notificationsEnabled: false,
        notificationsWebhookUrl: null,
      }),
    (error) => {
      assert.deepEqual(error.missing, [
        'EXPECTED_CONTRACT_CODEHASH',
        'EXPECTED_ABI_FINGERPRINT',
        'NOTIFICATIONS_ENABLED=true',
      ]);
      assert.match(error.message, /COTSEL_ENVIRONMENT=staging/);
      return true;
    },
  );
});

const DEMO_ONLY = {
  profile: 'staging',
  ...PINNED,
  chainId: 84532,
  contractAddress: '0xE8787748547A6ce40287CDE678A58e385b65d069',
  demoAlertsDisabled: true,
  notificationsEnabled: false,
  notificationsWebhookUrl: null,
};

test('the selected Base Sepolia staging demo can skip notification delivery', () => {
  assert.doesNotThrow(() => assertDeploymentPins(DEMO_ONLY));
});

test('the demo alert exception cannot disable contract identity or production controls', () => {
  assert.throws(
    () => assertDeploymentPins({ ...DEMO_ONLY, expectedContractCodehash: null }),
    /EXPECTED_CONTRACT_CODEHASH/,
  );
  assert.throws(
    () => assertDeploymentPins({ ...DEMO_ONLY, expectedAbiFingerprint: null }),
    /EXPECTED_ABI_FINGERPRINT/,
  );
  assert.throws(
    () => assertDeploymentPins({ ...DEMO_ONLY, profile: 'production' }),
    /only for the selected/,
  );
  assert.throws(
    () => assertDeploymentPins({ ...DEMO_ONLY, profile: 'local' }),
    /only for the selected/,
  );
  assert.throws(
    () => assertDeploymentPins({ ...DEMO_ONLY, chainId: 8453 }),
    /only for the selected/,
  );
  assert.throws(
    () =>
      assertDeploymentPins({
        ...DEMO_ONLY,
        contractAddress: '0x1111111111111111111111111111111111111111',
      }),
    /only for the selected/,
  );
  assert.throws(
    () => assertDeploymentPins({ ...DEMO_ONLY, notificationsEnabled: true }),
    /only for the selected/,
  );
});

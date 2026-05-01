import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');

test('trusted dashboard session helper fails closed without service-auth keys', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/trusted-dashboard-session.mjs',
      '--account-id',
      'demo-admin-001',
      '--role',
      'admin',
      '--wallet-address',
      '0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a',
      '--profile-file',
      '.env.missing-for-test',
    ],
    {
      cwd: ROOT_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON/u);
  assert.doesNotMatch(result.stdout, /sessionId/u);
});

function spawnNode(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('trusted dashboard session helper posts to the versioned agroasys exchange route', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: rawBody,
      });

      if (req.method !== 'POST' || req.url !== '/api/auth/v1/session/exchange/agroasys') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'unexpected route' }));
        return;
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            sessionId: 'test-session-id',
            expiresAt: 1777486223,
          },
        }),
      );
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address !== 'string');

    const result = await spawnNode(
      [
        'scripts/trusted-dashboard-session.mjs',
        '--auth-base-url',
        `http://127.0.0.1:${address.port}/api/auth/v1`,
        '--account-id',
        'demo-admin-001',
        '--role',
        'admin',
        '--wallet-address',
        '0x4beB8eeEC8dA57CaB76D2cAFD27Af6dFA22f972a',
        '--profile-file',
        '.env.missing-for-test',
        '--output',
        '/tmp/cotsel-dashboard-session-test.json',
      ],
      {
        cwd: ROOT_DIR,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON:
            '[{"id":"test-key","secret":"test-secret","active":true}]',
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/auth/v1/session/exchange/agroasys');
    assert.equal(requests[0].headers['x-api-key'], 'test-key');
    assert.match(result.stdout, /test-ses/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

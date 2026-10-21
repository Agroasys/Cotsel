/** SPDX-License-Identifier: Apache-2.0 */
import path from 'path';
import { fork } from 'child_process';
import { once } from 'events';
import { createBoundUserActionFixture } from './helpers/boundUserActionFixture';
import { PAIRED_PROTOCOL, parsePairedCommand } from './helpers/pairedLifecycleProtocol';
import { USER_ACTION_RETIREMENT_PATH } from '../src/core/userActionEngine/retirementTransport';

describe('test-only paired bridge protocol boundary', () => {
  const retirement = {
    protocol: PAIRED_PROTOCOL,
    commandId: 'retirement',
    command: 'verifyRetirement',
    transport: {
      url: 'https://127.0.0.1:4443' + USER_ACTION_RETIREMENT_PATH,
      owningServiceId: 'owner',
      apiKey: 'fixture-callback',
      apiSecret: 'fixture-only',
      timeoutMs: 1000,
    },
  };
  async function start() {
    const fixture = await createBoundUserActionFixture();
    const receipt = {
      hash: fixture.binding.fundingTransactionHash,
      to: fixture.binding.escrowAddress,
      status: 1,
      blockNumber: 100,
      blockHash: fixture.binding.fundingBlockHash,
      logs: [
        {
          address: fixture.binding.escrowAddress,
          topics: ['0x' + '1'.repeat(64)],
          data: '0x',
          index: 0,
        },
      ],
    };
    const witness = {
      chainId: fixture.binding.chainId,
      receipt,
      blocks: [
        { number: 100, hash: receipt.blockHash },
        { number: 200, hash: '0x' + '2'.repeat(64) },
      ],
      finalizedBlockNumber: 200,
    };
    return {
      protocol: PAIRED_PROTOCOL,
      command: 'start',
      commandId: 'start',
      custodyMode: 'raw',
      serviceAuth: { apiKeyId: 'owner', secret: 'fixture-only' },
      tls: { keyPath: '/tmp/test-only-key', certificatePath: '/tmp/test-only-certificate' },
      executionBinding: fixture.binding,
      fundingWitnesses: [witness, structuredClone(witness)],
      barrier: null,
    };
  }
  test('valid typed seed is a witness input, never a funding or policy approval', async () => {
    const seed = await start();
    expect(parsePairedCommand(seed)).toEqual(seed);
    // These intentionally incomplete ABI logs pass only transport shape. The actual funding
    // verifier, exercised by the PostgreSQL child suite, still decides original funding.
    expect(
      parsePairedCommand({
        protocol: PAIRED_PROTOCOL,
        commandId: 'inspect',
        command: 'inspectCounters',
      }),
    ).toMatchObject({ command: 'inspectCounters' });
  });
  test.each(['unexpected_sql', 'privateKey', 'fundingApproved', 'enableProduction'])(
    'rejects extra authority/config key %s',
    async (key) => {
      const seed = await start();
      expect(() => parsePairedCommand({ ...seed, [key]: true })).toThrow();
    },
  );
  test('rejects owner substitution, unsupported action, nonabsolute TLS paths and witness expansion', async () => {
    const seed = await start();
    expect(() =>
      parsePairedCommand({ ...seed, serviceAuth: { ...seed.serviceAuth, apiKeyId: 'foreign' } }),
    ).toThrow();
    expect(() =>
      parsePairedCommand({
        ...seed,
        executionBinding: { ...seed.executionBinding, action: 'open_dispute' },
      }),
    ).toThrow();
    expect(() => parsePairedCommand({ ...seed, tls: { ...seed.tls, keyPath: './key' } })).toThrow();
    expect(() =>
      parsePairedCommand({ ...seed, fundingWitnesses: [seed.fundingWitnesses[0]] }),
    ).toThrow();
    const changed = structuredClone(seed);
    changed.fundingWitnesses[0].receipt.logs[0].data = 'private provider diagnostic';
    expect(() => parsePairedCommand(changed)).toThrow();
    changed.fundingWitnesses[0].receipt.logs = Array(33).fill(
      seed.fundingWitnesses[0].receipt.logs[0],
    );
    expect(() => parsePairedCommand(changed)).toThrow();
  });
  test('no arbitrary scoped mutation or SQL command is accepted', () => {
    for (const command of ['executeSql', 'observeOnce', 'sign', 'broadcast'])
      expect(() =>
        parsePairedCommand({ protocol: PAIRED_PROTOCOL, commandId: 'invalid', command }),
      ).toThrow();
    expect(() =>
      parsePairedCommand({
        protocol: PAIRED_PROTOCOL,
        commandId: 'invalid',
        command: 'expirePreSignLeases',
        operation: 'other',
      }),
    ).toThrow();
  });
  test.each(['127.0.0.1', '[::1]', 'localhost'])(
    'accepts only explicit loopback retirement read configuration (%s)',
    (host) => {
      const value = {
        ...retirement,
        transport: {
          ...retirement.transport,
          url: `https://${host}:4443${USER_ACTION_RETIREMENT_PATH}`,
        },
      };
      expect(parsePairedCommand(value)).toEqual(value);
    },
  );
  test.each([
    'http://127.0.0.1:4443',
    'https://backend.example.test',
    'https://127.0.0.2',
    'https://10.0.0.1',
    'https://127.0.0.1.evil.example.test',
    'https://username:secret@127.0.0.1',
  ])('rejects non-loopback or credential-bearing retirement target %s', (origin) => {
    expect(() =>
      parsePairedCommand({
        ...retirement,
        transport: { ...retirement.transport, url: origin + USER_ACTION_RETIREMENT_PATH },
      }),
    ).toThrow();
  });
  test.each([
    '/wrong-path',
    USER_ACTION_RETIREMENT_PATH + '?scope=foreign',
    USER_ACTION_RETIREMENT_PATH + '#fragment',
    USER_ACTION_RETIREMENT_PATH + '/',
  ])('rejects route/query/fragment override %s', (route) => {
    expect(() =>
      parsePairedCommand({
        ...retirement,
        transport: { ...retirement.transport, url: 'https://127.0.0.1:4443' + route },
      }),
    ).toThrow();
  });
  test.each([
    { timeoutMs: 0 },
    { timeoutMs: 9001 },
    { timeoutMs: 1.5 },
    { apiSecret: '' },
    { apiSecret: 'x'.repeat(257) },
    { owningServiceId: 'foreign owner' },
    { apiKey: 'x'.repeat(129) },
  ])('rejects malformed bounded retirement config %j', (change) => {
    expect(() =>
      parsePairedCommand({ ...retirement, transport: { ...retirement.transport, ...change } }),
    ).toThrow();
  });
  test('caller cannot select scope, supply proof, or augment transport authority', () => {
    for (const key of ['scope', 'evidence', 'fundingApproved', 'enableProduction'])
      expect(() => parsePairedCommand({ ...retirement, [key]: {} })).toThrow();
    expect(() =>
      parsePairedCommand({ ...retirement, transport: { ...retirement.transport, scope: {} } }),
    ).toThrow();
  });
  test('entrypoint exits without explicit opt-in before provisioning a database or listener', async () => {
    const child = fork(path.resolve(__dirname, 'helpers/pairedLifecycleBridge.ts'), [], {
      cwd: path.resolve(__dirname, '..'),
      execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
      env: { ...process.env, COTSEL_PAIRED_LIFECYCLE_FIXTURE: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: unknown[] = [];
    child.on('message', (message) => messages.push(message));
    expect(await once(child, 'exit')).toEqual([2, null]);
    expect(messages).toEqual([]);
  });
});

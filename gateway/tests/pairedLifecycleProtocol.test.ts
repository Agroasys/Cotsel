/** SPDX-License-Identifier: Apache-2.0 */
import path from 'path';
import { fork } from 'child_process';
import { once } from 'events';
import { createBoundUserActionFixture } from './helpers/boundUserActionFixture';
import { PAIRED_PROTOCOL, parsePairedCommand } from './helpers/pairedLifecycleProtocol';

describe('test-only paired bridge protocol boundary', () => {
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

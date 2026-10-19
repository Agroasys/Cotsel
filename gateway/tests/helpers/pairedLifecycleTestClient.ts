/** SPDX-License-Identifier: Apache-2.0 */
import { fork, execFileSync, type ChildProcess } from 'child_process';
import { once } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import https from 'https';
import { Pool } from 'pg';
import { createServiceAuthHeaders } from '../../src/core/serviceAuth';
import {
  PAIRED_PROTOCOL,
  type PairedCommand,
  type PairedEvent,
  type PairedStart,
} from './pairedLifecycleProtocol';

export function createPairedLifecycleTestClient() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cotsel-paired-tls-'));
  const keyPath = path.join(directory, 'key.pem'),
    certificatePath = path.join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-days',
      '1',
      '-subj',
      '/CN=Cotsel local paired fixture',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const ca = readFileSync(certificatePath);
  let child: ChildProcess | undefined,
    sequence = 0,
    databaseName: string | undefined;
  const events: PairedEvent[] = [];
  let output = '';
  const listeners = new Set<() => void>();
  function wait(predicate: (event: PairedEvent) => boolean): Promise<PairedEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error('Paired fixture IPC deadline'));
      }, 30000);
      const check = () => {
        const index = events.findIndex(predicate);
        if (index >= 0) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(events.splice(index, 1)[0]);
        } else if (child && (child.exitCode !== null || child.signalCode !== null)) {
          clearTimeout(timer);
          listeners.delete(check);
          reject(new Error('Paired fixture exited'));
        }
      };
      listeners.add(check);
      check();
    });
  }
  async function command(
    value: Omit<PairedCommand, 'protocol' | 'commandId'> | Record<string, unknown>,
  ) {
    const commandId = `test_${++sequence}`;
    const response = wait(
      (event) => event.commandId === commandId || (event.event === 'error' && !event.commandId),
    );
    child!.send({ ...value, protocol: PAIRED_PROTOCOL, commandId });
    return response;
  }
  return {
    tls: { keyPath, certificatePath },
    output: () => output,
    async start(seed: Omit<PairedStart, 'tls' | 'protocol' | 'commandId' | 'command'>) {
      child = fork(path.resolve(__dirname, 'pairedLifecycleBridge.ts'), [], {
        cwd: path.resolve(__dirname, '../..'),
        execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
        env: { ...process.env, COTSEL_PAIRED_LIFECYCLE_FIXTURE: 'true' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.on('message', (event: PairedEvent) => {
        events.push(event);
        for (const listener of listeners) listener();
      });
      child.on('exit', () => {
        for (const listener of listeners) listener();
      });
      for (const stream of [child.stdout, child.stderr])
        stream!.on('data', (data) => {
          output += String(data);
        });
      const result = await command({
        ...seed,
        command: 'start',
        tls: { keyPath, certificatePath },
      });
      databaseName = result.databaseName;
      return result;
    },
    command,
    wait,
    async http(
      baseUrl: string,
      route: string,
      method: 'POST' | 'GET',
      body: unknown,
      key?: string,
      credentials = { apiKeyId: 'owner', secret: 'test-only-paired-secret' },
      signal?: AbortSignal,
    ) {
      const url = new URL(baseUrl + route),
        serialized = body === undefined ? undefined : JSON.stringify(body);
      const headers = createServiceAuthHeaders({
        apiKey: credentials.apiKeyId,
        apiSecret: credentials.secret,
        method,
        path: url.pathname,
        body: serialized,
      });
      return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const request = https.request(
          url,
          {
            method,
            ca,
            signal,
            headers: {
              ...headers,
              'content-type': 'application/json',
              ...(key ? { 'Idempotency-Key': key } : {}),
            },
          },
          (response) => {
            let responseBody = '';
            response.on('data', (data) => {
              responseBody += String(data);
            });
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode!,
                  body: JSON.parse(responseBody) as unknown,
                });
              } catch {
                reject(new Error('Invalid fixture response'));
              }
            });
          },
        );
        request.on('error', reject);
        request.setTimeout(30000, () => request.destroy(new Error('Controlled HTTPS deadline')));
        request.end(serialized);
      });
    },
    async close() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        try {
          await command({ command: 'shutdown' });
        } catch {
          child.kill('SIGKILL');
        }
        await exited;
      }
      if (databaseName && /^ua_[0-9a-f]{32}$/.test(databaseName)) {
        // Parent owns cleanup after a killed child; never select a deployed database.
        const admin = new Pool({
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
        });
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
          await admin.query(`DROP ROLE IF EXISTS ${databaseName}`);
        } finally {
          await admin.end();
        }
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

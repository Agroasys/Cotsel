import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
import {
  claimTriggerDispatch,
  getUnresolvedSignerDispatch,
  resolveSignerDispatch,
} from '../src/database/oracle-dispatch-reservation';
import { fundedBindingFixture } from './helpers/fundedBinding';
let mockRuntimePool: Pool;
jest.mock('../src/database/connection', () => ({
  pool: {
    query: (...args: unknown[]) =>
      (mockRuntimePool.query as (...values: unknown[]) => unknown)(...args),
    connect: () => mockRuntimePool.connect(),
  },
}));
const enabled = process.env.RUN_ORACLE_DISPATCH_POSTGRES === 'true';
const suite = enabled ? describe : describe.skip;
const scope = '31337:0x3333333333333333333333333333333333333333';
const hash = `0x${'a'.repeat(64)}`;
const proof = () => ({
  policy: 'oracle_dispatch_nonce_finality_v1' as const,
  signerScope: scope,
  transactionHash: hash,
  blockNumber: 100,
  blockHash: `0x${'b'.repeat(64)}`,
  receiptStatus: 1 as const,
  witnessIds: ['1'.repeat(64), '2'.repeat(64)] as [string, string],
  verifiedAt: new Date().toISOString(),
});
suite('Oracle durable signer dispatch exclusion (disposable PostgreSQL)', () => {
  let admin: Pool;
  let database: string;
  let role: string;
  beforeAll(async () => {
    const url = new URL(
      process.env.ORACLE_DISPATCH_POSTGRES_ADMIN_URL ??
        'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    );
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('Disposable Oracle proof requires local PostgreSQL');
    url.pathname = '/postgres';
    admin = new Pool({ connectionString: url.toString() });
    database = `oracle_dispatch_${randomBytes(6).toString('hex')}`;
    role = `${database}_runtime`;
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;
    mockRuntimePool = new Pool({ connectionString: url.toString(), max: 4 });
    await runVersionedMigrations({
      pool: mockRuntimePool,
      serviceName: 'oracle',
      runtimeDbUser: role,
      manifestPath: path.resolve(__dirname, '../src/database/migrations.json'),
    });
  }, 30000);
  afterAll(async () => {
    await mockRuntimePool?.end();
    if (admin) {
      if (database) await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      if (role) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
  async function insert(key: string) {
    await mockRuntimePool.query(
      `INSERT INTO oracle_triggers(action_key,request_id,idempotency_key,trade_id,trigger_type,status,funded_binding) VALUES($1,$1,$1,'1','RELEASE_STAGE_1','PENDING',$2::jsonb)`,
      [key, JSON.stringify(fundedBindingFixture())],
    );
  }
  it('serializes different actions through one original signer reservation across connections', async () => {
    await insert('a');
    await insert('b');
    const results = await Promise.all([
      claimTriggerDispatch('a', scope),
      claimTriggerDispatch('b', scope),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const original = (await getUnresolvedSignerDispatch(scope))!;
    const other = original.idempotency_key === 'a' ? 'b' : 'a';
    expect(await claimTriggerDispatch(other, scope)).toBe(false);
    await mockRuntimePool.query(
      `UPDATE oracle_triggers SET status='CONFIRMED',confirmation_stage='FINALIZED',tx_hash=$2 WHERE idempotency_key=$1`,
      [original.idempotency_key, hash],
    );
    // A mutable workflow status cannot retire nonce exposure.
    expect(await claimTriggerDispatch(other, scope)).toBe(false);
    await expect(
      resolveSignerDispatch(original.idempotency_key, {
        ...proof(),
        verifiedAt: new Date(Date.now() - 20000).toISOString(),
      }),
    ).rejects.toThrow('Fresh');
    await resolveSignerDispatch(original.idempotency_key, proof());
    await resolveSignerDispatch(original.idempotency_key, proof());
    expect(await claimTriggerDispatch(other, scope)).toBe(true);
    await expect(
      mockRuntimePool.query(
        'UPDATE oracle_triggers SET dispatch_finality_evidence=NULL WHERE idempotency_key=$1',
        [original.idempotency_key],
      ),
    ).rejects.toThrow('oracle_dispatch_resolution_is_immutable');
    await expect(
      mockRuntimePool.query(
        'UPDATE oracle_triggers SET dispatch_signer_scope=$2 WHERE idempotency_key=$1',
        [other, '31337:0x4444444444444444444444444444444444444444'],
      ),
    ).rejects.toThrow('oracle_dispatch_signer_is_immutable');
    expect((await getUnresolvedSignerDispatch(scope))?.idempotency_key).toBe(other);
  });
  it('retains a hashless unknown send across a new operation and restart', async () => {
    await insert('c');
    expect(await claimTriggerDispatch('c', scope)).toBe(false);
    const original = await getUnresolvedSignerDispatch(scope);
    expect(original?.tx_hash).toBeNull();
    expect(await claimTriggerDispatch('c', scope)).toBe(false);
    await expect(resolveSignerDispatch(original!.idempotency_key, proof())).rejects.toThrow(
      'changed',
    );
  });
});

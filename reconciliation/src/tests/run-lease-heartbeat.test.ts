// Must come first: RunLease imports the lease store, which loads src/config.ts.
import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RunLease, createLeaseOwner } from '../core/runLease';
import { LeaseLostError } from '../database/leases';
import type { RunLeaseIdentity } from '../types';

const IDENTITY: RunLeaseIdentity = { runKey: 'daemon-1', owner: 'worker-a', epoch: 1 };

/** Let the interval fire and its async body settle. */
async function tick(times = 1): Promise<void> {
  await delay(15 * times);
}

test('a worker identity names a host, a process, and a unique run', () => {
  const owner = createLeaseOwner();
  const [host, pid, suffix] = owner.split(':');

  assert.ok(host.length > 0);
  assert.equal(pid, String(process.pid));
  assert.match(suffix, /^[0-9a-f]{8}$/u);
  // A reused pid must not make two workers indistinguishable.
  assert.notEqual(createLeaseOwner(), owner);
});

test('a held lease keeps beating and never reports lost', async () => {
  let beats = 0;
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeat: async () => {
      beats += 1;
      return true;
    },
  });

  lease.start();
  await tick(4);
  lease.stop();

  assert.ok(beats >= 2, `expected repeated heartbeats, saw ${beats}`);
  assert.equal(lease.isLost, false);
  lease.assertHeld();
});

test('a rejected heartbeat marks the lease lost and stops beating', async () => {
  let beats = 0;
  let lostWith: RunLeaseIdentity | null = null;

  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    onLost: (identity) => {
      lostWith = identity;
    },
    heartbeat: async () => {
      beats += 1;
      return false;
    },
  });

  lease.start();
  await tick(4);

  assert.equal(lease.isLost, true);
  assert.deepEqual(lostWith, IDENTITY);
  // Once lost, the timer is cleared: a displaced worker must not keep writing
  // to a row a successor now owns.
  const beatsAtLoss = beats;
  await tick(4);
  assert.equal(beats, beatsAtLoss);

  assert.throws(() => lease.assertHeld(), LeaseLostError);
});

test('a heartbeat that throws is not treated as a lost lease', async () => {
  // An unreachable database says nothing about who owns the lease. Treating it
  // as loss would abandon healthy runs during any brief Postgres blip.
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeat: async () => {
      throw new Error('connection terminated');
    },
  });

  lease.start();
  await tick(4);
  lease.stop();

  assert.equal(lease.isLost, false);
  lease.assertHeld();
});

test('the lost callback fires once, however many beats are rejected', async () => {
  let lostCount = 0;
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    onLost: () => {
      lostCount += 1;
    },
    heartbeat: async () => false,
  });

  lease.start();
  await tick(6);

  assert.equal(lostCount, 1);
});

test('starting twice does not double the heartbeat rate', async () => {
  let beats = 0;
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeat: async () => {
      beats += 1;
      return true;
    },
  });

  lease.start();
  lease.start();
  await tick(4);
  lease.stop();
  const single = beats;

  assert.ok(single >= 2);
  await tick(4);
  assert.equal(beats, single, 'stop() must clear every timer that start() created');
});

test('a terminal run hands its lease back', async () => {
  const released: RunLeaseIdentity[] = [];
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeat: async () => true,
    release: async (identity) => {
      released.push(identity);
      return true;
    },
  });

  lease.start();
  await lease.release();

  assert.deepEqual(released, [IDENTITY]);
});

test('a lost lease is not released', async () => {
  // The successor owns the row now; clearing its lease would hand the key to a
  // third worker while the successor is mid-run.
  let releaseCalls = 0;
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeat: async () => false,
    release: async () => {
      releaseCalls += 1;
      return true;
    },
  });

  lease.start();
  await tick(4);
  await lease.release();

  assert.equal(lease.isLost, true);
  assert.equal(releaseCalls, 0);
});

test('a release that fails does not throw at the caller', async () => {
  // The run's status is already committed; a stranded lease only costs the next
  // worker a TTL wait and must not turn a finished run into a failed one.
  const lease = new RunLease({
    identity: IDENTITY,
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeat: async () => true,
    release: async () => {
      throw new Error('connection terminated');
    },
  });

  lease.start();
  await lease.release();
});

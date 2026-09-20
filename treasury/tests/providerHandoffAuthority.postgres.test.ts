/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-09 / FAIL-11 acceptance drill, against a real PostgreSQL instance.
 *
 * The claim under test is that provider state is append-only: a `CREATED` or
 * `FAILED` report never advances a handoff, a delayed callback never regresses
 * one, and two contradictory terminal claims freeze rather than overwrite, with
 * both preserved. Half of that lives in the schema -- an append-only trigger, a
 * pinned vocabulary, a revoked grant -- so a mocked pool would prove none of it.
 */
import { Pool } from 'pg';
import {
  applyTreasuryTestEnv,
  provisionTreasuryDatabase,
  runPostgresIntegrationTests,
} from './helpers/treasuryPostgres';

type TreasuryQueries = typeof import('../src/database/queries');
type TreasuryConnection = typeof import('../src/database/connection');

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;

describePostgres('provider handoff append-only state (postgres)', () => {
  jest.setTimeout(120_000);

  let cleanup: (() => Promise<void>) | null = null;
  let queries: TreasuryQueries;
  let connection: TreasuryConnection;
  let sidecar: Pool;
  let sequence = 0;

  beforeAll(async () => {
    const provisioned = await provisionTreasuryDatabase('treasury_handoff_authority');
    cleanup = provisioned.cleanup;
    applyTreasuryTestEnv(provisioned.dbName);

    jest.resetModules();
    queries = await import('../src/database/queries');
    connection = await import('../src/database/connection');

    sidecar = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: provisioned.dbName,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  });

  afterAll(async () => {
    await sidecar?.end();
    await connection?.closeConnection();
    await cleanup?.();
  });

  async function seedHandoff(
    partnerStatus: 'CREATED' | 'SUBMITTED' = 'SUBMITTED',
  ): Promise<{ entryId: number; scope: string }> {
    sequence += 1;
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `handoff-authority-${sequence}`,
      tradeId: `trade-handoff-authority-${sequence}`,
      txHash: `0xhandoff${sequence}`,
      blockNumber: 100 + sequence,
      blockHash: `0x${(100 + sequence).toString(16).padStart(64, '0')}`,
      logIndex: 0,
      logAddress: `0x${'11'.repeat(20)}`,
      logIdentityHash: 'b'.repeat(64),
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: {},
    });

    await queries.upsertTreasuryPartnerHandoff({
      ledgerEntryId: entry.id,
      partnerCode: 'bridge',
      handoffReference: `bridge-ref-${sequence}`,
      partnerStatus,
      actor: 'postgres-test',
      initiatedAt: new Date('2026-04-16T08:05:00.000Z'),
    });

    return { entryId: entry.id, scope: 'LEDGER_ENTRY' };
  }

  function evidence(
    entryId: number,
    providerEventId: string,
    partnerStatus:
      | 'CREATED'
      | 'SUBMITTED'
      | 'ACKNOWLEDGED'
      | 'PROCESSING'
      | 'COMPLETED'
      | 'FAILED'
      | 'RETURNED',
    overrides: Record<string, unknown> = {},
  ) {
    return {
      ledgerEntryId: entryId,
      partnerCode: 'bridge' as const,
      providerEventId,
      eventType: 'transfer.updated.status_transitioned',
      partnerStatus,
      observedAt: new Date('2026-04-16T08:10:00.000Z'),
      ...overrides,
    };
  }

  it('advances on a forward provider transition', async () => {
    const { entryId } = await seedHandoff();

    const result = await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `ack-${entryId}`, 'ACKNOWLEDGED'),
    );

    expect(result.transition).toBe('ADVANCE');
    expect(result.applied).toBe(true);
    expect(result.handoff.partner_status).toBe('ACKNOWLEDGED');
  });

  /**
   * The reordered-callback case. The event is still stored -- it is evidence
   * either way -- but the authoritative state does not move backwards.
   */
  it('records a delayed callback without regressing the established state', async () => {
    const { entryId } = await seedHandoff();
    await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `ack2-${entryId}`, 'ACKNOWLEDGED'),
    );

    const stale = await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `late-${entryId}`, 'SUBMITTED'),
    );

    expect(stale.transition).toBe('STALE');
    expect(stale.applied).toBe(false);
    expect(stale.handoff.partner_status).toBe('ACKNOWLEDGED');

    const events = await queries.listTreasuryPartnerHandoffEventsByLedgerEntryId(entryId);
    expect(events.map((event) => event.partner_status)).toEqual(['ACKNOWLEDGED', 'SUBMITTED']);
  });

  /**
   * The completion is refused, but it is still something the provider claimed.
   * Refusing before recording it would delete the claim, and the claim is what
   * a later dispute turns on.
   */
  it('records a completion carrying no evidence, then refuses it', async () => {
    const { entryId } = await seedHandoff();

    await expect(
      queries.appendTreasuryPartnerHandoffEvidence(
        evidence(entryId, `bare-${entryId}`, 'COMPLETED'),
      ),
    ).rejects.toThrow(/authoritative provider or bank evidence/i);

    const stored = await queries.getTreasuryPartnerHandoffByLedgerEntryId(entryId);
    expect(stored?.partner_status).toBe('SUBMITTED');

    const events = await queries.listTreasuryPartnerHandoffEventsByLedgerEntryId(entryId);
    expect(events.map((event) => event.partner_status)).toEqual(['COMPLETED']);
  });

  /**
   * The finding itself. Two terminal claims about one instruction cannot both
   * be true, and last-write-wins would silently pick the later one -- deleting
   * the record that the earlier claim was ever made.
   */
  it('freezes on contradictory terminal evidence and preserves both claims', async () => {
    const { entryId } = await seedHandoff();
    await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `done-${entryId}`, 'COMPLETED', { evidenceReference: 'receipt-1' }),
    );

    await expect(
      queries.appendTreasuryPartnerHandoffEvidence(
        evidence(entryId, `fail-${entryId}`, 'FAILED', { failureCode: 'returned_by_bank' }),
      ),
    ).rejects.toThrow(/already terminal at COMPLETED/i);

    const stored = await queries.getTreasuryPartnerHandoffByLedgerEntryId(entryId);
    expect(stored?.partner_status).toBe('COMPLETED');
    expect(stored?.frozen_at).not.toBeNull();
    expect(stored?.frozen_reason).toMatch(/FAILED/);

    // Both claims survive: the retained one on the row, the contradicting one
    // in the evidence log beside the conflict that refused it.
    const events = await queries.listTreasuryPartnerHandoffEventsByLedgerEntryId(entryId);
    expect(events.map((event) => event.partner_status)).toEqual(['COMPLETED', 'FAILED']);

    const conflicts = await sidecar.query(
      `SELECT record_type, retained_status, conflicting_status, provider_event_id
       FROM treasury_partner_handoff_conflicts
       WHERE scope = 'LEDGER_ENTRY' AND subject_id = $1`,
      [entryId],
    );
    expect(conflicts.rows).toHaveLength(1);
    expect(conflicts.rows[0].record_type).toBe('CONFLICT');
    expect(conflicts.rows[0].retained_status).toBe('COMPLETED');
    expect(conflicts.rows[0].conflicting_status).toBe('FAILED');
  });

  /**
   * The deliveries that arrive *after* a contradiction are the ones a dispute
   * turns on. The projection stays frozen; the log keeps growing.
   */
  it('retains provider deliveries that arrive while the handoff is frozen', async () => {
    const { entryId } = await seedHandoff();
    await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `done2-${entryId}`, 'COMPLETED', { evidenceReference: 'receipt-2' }),
    );
    await expect(
      queries.appendTreasuryPartnerHandoffEvidence(
        evidence(entryId, `fail2-${entryId}`, 'RETURNED'),
      ),
    ).rejects.toThrow();

    const afterFreeze = await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `post-freeze-${entryId}`, 'PROCESSING'),
    );

    expect(afterFreeze.transition).toBe('FROZEN');
    expect(afterFreeze.applied).toBe(false);
    expect(afterFreeze.handoff.partner_status).toBe('COMPLETED');
    expect(afterFreeze.handoff.frozen_at).not.toBeNull();

    const events = await queries.listTreasuryPartnerHandoffEventsByLedgerEntryId(entryId);
    expect(events.map((event) => event.partner_status)).toEqual([
      'COMPLETED',
      'RETURNED',
      'PROCESSING',
    ]);
  });

  it('refuses to rewrite or delete recorded provider evidence', async () => {
    const { entryId } = await seedHandoff();
    await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `immutable-${entryId}`, 'ACKNOWLEDGED'),
    );

    await expect(
      sidecar.query(
        `UPDATE treasury_partner_handoff_events SET partner_status = 'COMPLETED' WHERE ledger_entry_id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sidecar.query(`DELETE FROM treasury_partner_handoff_events WHERE ledger_entry_id = $1`, [
        entryId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The upsert route records the intent to hand off, under internal service
   * auth and with no evidence field for a completion to be checked against. A
   * COMPLETED here would enter the authoritative state, and the accounting
   * projection, with nothing external corroborating it.
   */
  it('refuses to create a handoff that is already COMPLETED', async () => {
    sequence += 1;
    const { entry } = await queries.upsertLedgerEntryWithInitialState({
      entryKey: `handoff-initial-complete-${sequence}`,
      tradeId: `trade-initial-complete-${sequence}`,
      txHash: `0xinitial${sequence}`,
      blockNumber: 500 + sequence,
      blockHash: `0x${(500 + sequence).toString(16).padStart(64, '0')}`,
      logIndex: 0,
      logAddress: `0x${'11'.repeat(20)}`,
      logIdentityHash: 'c'.repeat(64),
      eventName: 'PlatformFeesPaidStage1',
      componentType: 'PLATFORM_FEE',
      amountRaw: '125000000',
      sourceTimestamp: new Date('2026-04-16T08:00:00.000Z'),
      metadata: {},
    });

    await expect(
      queries.upsertTreasuryPartnerHandoff({
        ledgerEntryId: entry.id,
        partnerCode: 'bridge',
        handoffReference: `bridge-initial-complete-${sequence}`,
        partnerStatus: 'COMPLETED',
        actor: 'postgres-test',
        initiatedAt: new Date('2026-04-16T08:05:00.000Z'),
      }),
    ).rejects.toThrow(/cannot be created as COMPLETED/i);

    expect(await queries.getTreasuryPartnerHandoffByLedgerEntryId(entry.id)).toBeNull();
  });

  it('still creates a handoff at an in-flight state', async () => {
    const { entryId } = await seedHandoff('SUBMITTED');
    const stored = await queries.getTreasuryPartnerHandoffByLedgerEntryId(entryId);

    expect(stored?.partner_status).toBe('SUBMITTED');
  });

  it('refuses to store a provider state it has no mapping for', async () => {
    const { entryId } = await seedHandoff();

    await expect(
      sidecar.query(
        `UPDATE treasury_partner_handoffs SET partner_status = 'SETTLED' WHERE ledger_entry_id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/status_vocabulary/);
  });

  /**
   * An approved correction is an appended record, not an edit. The conflict it
   * resolves is still there afterwards, which is what makes the history
   * reproducible by someone who was not present for the incident.
   */
  it('clears a freeze only through an approved correction that preserves the conflict', async () => {
    const { entryId } = await seedHandoff();
    await queries.appendTreasuryPartnerHandoffEvidence(
      evidence(entryId, `done3-${entryId}`, 'COMPLETED', { evidenceReference: 'receipt-3' }),
    );
    await expect(
      queries.appendTreasuryPartnerHandoffEvidence(evidence(entryId, `fail3-${entryId}`, 'FAILED')),
    ).rejects.toThrow();

    const conflict = await sidecar.query<{ id: number }>(
      `SELECT id FROM treasury_partner_handoff_conflicts
       WHERE scope = 'LEDGER_ENTRY' AND subject_id = $1 AND record_type = 'CONFLICT'`,
      [entryId],
    );

    const corrected = await queries.correctFrozenTreasuryPartnerHandoff({
      ledgerEntryId: entryId,
      resolvesConflictId: conflict.rows[0].id,
      approvalReference: 'exception-2026-04-16',
      resolvedStatus: 'COMPLETED',
      actor: 'finance-approver',
      detail: 'Provider confirmed the FAILED callback referenced a different transfer',
    });

    expect(corrected.frozen_at).toBeNull();
    expect(corrected.partner_status).toBe('COMPLETED');

    const records = await sidecar.query(
      `SELECT record_type, approval_reference FROM treasury_partner_handoff_conflicts
       WHERE scope = 'LEDGER_ENTRY' AND subject_id = $1 ORDER BY id`,
      [entryId],
    );
    expect(records.rows.map((row: { record_type: string }) => row.record_type)).toEqual([
      'CONFLICT',
      'CORRECTION',
    ]);
    expect(records.rows[1].approval_reference).toBe('exception-2026-04-16');
  });

  it('refuses a correction that names no approving authority', async () => {
    await expect(
      sidecar.query(
        `INSERT INTO treasury_partner_handoff_conflicts (
           record_type, scope, subject_id, partner_code, retained_status,
           conflicting_status, detail, actor, observed_at
         ) VALUES ('CORRECTION', 'LEDGER_ENTRY', 1, 'bridge', 'COMPLETED', 'FAILED', 'x', 'y', NOW())`,
      ),
    ).rejects.toThrow(/correction_is_approved/);
  });
});

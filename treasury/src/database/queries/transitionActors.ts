/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PoolClient } from 'pg';
import type { TransitionActorRole } from '../../core/accountingPolicy';
import { pool } from '../connection';

export type TransitionSubjectType = 'SWEEP_BATCH' | 'ACCOUNTING_PERIOD';

export interface TreasuryTransitionActor {
  id: number;
  subject_type: TransitionSubjectType;
  subject_id: number;
  from_status: string;
  to_status: string;
  actor: string;
  actor_role: TransitionActorRole;
  recorded_at: Date;
  metadata: Record<string, unknown>;
}

/**
 * Read and write the chain on the caller's client so the recorded actor commits
 * with the transition it belongs to: a rolled-back transition must not leave an
 * approval behind, and a committed one must not lose its attribution.
 */
export async function listTransitionActors(
  client: PoolClient,
  subjectType: TransitionSubjectType,
  subjectId: number,
): Promise<TreasuryTransitionActor[]> {
  const result = await client.query<TreasuryTransitionActor>(
    `SELECT *
     FROM treasury_transition_actors
     WHERE subject_type = $1
       AND subject_id = $2
     ORDER BY id ASC`,
    [subjectType, subjectId],
  );

  return result.rows;
}

export async function recordTransitionActor(
  client: PoolClient,
  data: {
    subjectType: TransitionSubjectType;
    subjectId: number;
    fromStatus: string;
    toStatus: string;
    actor: string;
    actorRole: TransitionActorRole;
    metadata?: Record<string, unknown>;
  },
): Promise<TreasuryTransitionActor> {
  const result = await client.query<TreasuryTransitionActor>(
    `INSERT INTO treasury_transition_actors (
        subject_type,
        subject_id,
        from_status,
        to_status,
        actor,
        actor_role,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING *`,
    [
      data.subjectType,
      data.subjectId,
      data.fromStatus,
      data.toStatus,
      data.actor,
      data.actorRole,
      JSON.stringify(data.metadata ?? {}),
    ],
  );

  return result.rows[0];
}

export async function listTransitionActorsForSubject(
  subjectType: TransitionSubjectType,
  subjectId: number,
): Promise<TreasuryTransitionActor[]> {
  const client = await pool.connect();

  try {
    return await listTransitionActors(client, subjectType, subjectId);
  } finally {
    client.release();
  }
}

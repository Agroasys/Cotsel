/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';

export interface SnapshotRunSelection {
  runKey?: string;
  requireImmutable?: boolean;
}

/** Fail closed when the reconciliation publication protocol is missing or disabled. */
export async function requireReconciliationSnapshotProtocol(
  reader: Pick<Pool, 'query'>,
): Promise<void> {
  const protocol = await reader.query<{ version: number | null }>(
    'SELECT public.reconciliation_export_evidence_version() AS version',
  );
  if (protocol.rows[0]?.version !== 1)
    throw new Error('Reconciliation evidence is unavailable or incomplete');
}

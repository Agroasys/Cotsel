import type { PoolClient } from 'pg';
import type { RunManifest } from '@agroasys/shared-db/reconciliationEvidence';
import { buildFreezeRequest } from '@agroasys/shared-db/freezeRequests';

/** The completing transaction persists the request only after its run is sealed. */
export async function recordRunFreezeRequests(client: PoolClient, manifest: RunManifest) {
  for (const entry of manifest.containments ?? []) {
    if (entry.openedRunKey !== manifest.runKey || !entry.citedFindings.length) continue;
    const request = buildFreezeRequest(manifest, entry);
    await client.query(
      `INSERT INTO reconcile_governance_freeze_requests
      (request_id, run_key, trade_id, incident_reference, episode, request)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (trade_id, incident_reference, episode) DO NOTHING`,
      [
        request.requestId,
        request.runKey,
        request.tradeId,
        request.incidentReference,
        request.episode,
        JSON.stringify(request),
      ],
    );
  }
}

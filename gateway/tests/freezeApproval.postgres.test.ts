import { generateKeyPairSync, sign } from 'node:crypto';
import { attestActionEvidence } from '@agroasys/shared-db/actionEvidence';
/** SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Interface } from 'ethers';
import { buildFreezeRequest } from '@agroasys/shared-db/freezeRequests';
import { parsePublicKeys } from '@agroasys/shared-db/reconciliationEvidence';
import { createContainmentEvidenceService } from '../src/core/containmentEvidence';
import { createPostgresFreezeReviewStore } from '../src/core/freezeReviewStore';
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { startGovernanceEvidenceServer } from './support/governanceEvidenceHarness';

const describePostgres = process.env.SETTLEMENT_ACTIVITY_DATABASE_URL ? describe : describe.skip;
const fixture = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../shared-db/fixtures/reconciliation-proof.v1.json'),
    'utf8',
  ),
);
const { privateKey: responseKey, publicKey: responsePublicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const responseSigner = {
  keyId: 'response-key',
  sign: async (bytes: Buffer) => sign('sha256', bytes, responseKey),
};
const SIGNER = '0x00000000000000000000000000000000000000aa';
const audit = {
  reason: 'Review the signed critical amount discrepancy.',
  ticketRef: 'INC-951',
  evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/INC-951' }],
};

describePostgres('recorded human approval of signed freeze requests', () => {
  jest.setTimeout(120_000);
  it('requires a durable approval before preparing the exact scoped pause, and records broadcast separately', async () => {
    const db = await createUserActionEnginePostgres();
    const request = buildFreezeRequest(
      fixture.proof.opening.seal.manifest,
      fixture.proof.opening.seal.manifest.containments[0],
    );
    const secondProof = structuredClone(fixture.tamperedProof);
    secondProof.recovery.runs['open-2002'].evidence.findings[0].indexedValue = '101';
    const rejected = buildFreezeRequest(
      secondProof.opening.seal.manifest,
      secondProof.opening.seal.manifest.containments[0],
    );
    let tampered = false;
    const service = createContainmentEvidenceService(
      {
        baseUrl: 'http://reconciliation.test',
        publicKeys: new Map([
          ...parsePublicKeys(JSON.stringify(fixture.keys)),
          [responseSigner.keyId, responsePublicKey],
        ]),
        timeoutMs: 1000,
        maxAgeSeconds: 900,
        context: fixture.context,
      },
      (async (input) => {
        const url = new URL(String(input));
        const body = url.pathname.endsWith(rejected.requestId)
          ? { request: rejected, proof: secondProof }
          : { request, proof: tampered ? fixture.tamperedProof : fixture.proof };
        return new Response(
          JSON.stringify(
            await attestActionEvidence(body, {
              challenge: url.searchParams.get('challenge')!,
              resource: url.pathname,
              signer: responseSigner,
              now: Date.parse(`${fixture.proof.recovery.latest.seal.manifest.completedAt}Z`) + 1000,
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
      () => Date.parse(`${fixture.proof.recovery.latest.seal.manifest.completedAt}Z`) + 1000,
    );
    const { server, baseUrl, governanceActionStore } = await startGovernanceEvidenceServer(
      {
        hasActiveProposal: false,
        approvalCount: 0,
        executed: false,
        scope: 'GLOBAL',
        tradeId: '0',
        incidentRef: null,
      },
      service,
      db.runtime,
    );
    const reviews = createPostgresFreezeReviewStore(db.runtime);
    const call = async (id: string, action: string, body: Record<string, unknown>, key: string) => {
      const response = await fetch(`${baseUrl}/governance/freeze-requests/${id}/${action}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sess-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ signerWallet: SIGNER, audit, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      expect((await call(request.requestId, 'prepare', {}, 'before-approval')).status).toBe(409);
      expect(await reviews.get(request.requestId)).toBeNull();
      tampered = true;
      expect(
        (await call(request.requestId, 'review', { decision: 'approved' }, 'tampered')).status,
      ).toBe(409);
      expect(await reviews.get(request.requestId)).toBeNull();
      tampered = false;
      expect(
        (await call(request.requestId, 'review', { decision: 'approved' }, 'approved')).status,
      ).toBe(200);
      expect(await reviews.get(request.requestId)).toMatchObject({
        decision: 'approved',
        reviewedBy: 'account:acct-admin',
      });
      const prepared = await call(request.requestId, 'prepare', {}, 'prepared');
      expect(prepared.status).toBe(200);
      const record = await governanceActionStore.get(prepared.body.data.actionId);
      expect(record?.audit.reconciliationFreezeRequest).toMatchObject({
        request: { requestId: request.requestId },
      });
      const tx = prepared.body.data.signing.txRequest;
      const decoded = new Interface(['function pauseTrade(uint256)']).decodeFunctionData(
        'pauseTrade',
        tx.data,
      );
      expect(decoded[0].toString()).toBe('2001');
      const confirmed = await fetch(
        `${baseUrl}/governance/actions/${prepared.body.data.actionId}/confirm`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer sess-admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ signerWallet: SIGNER, txHash: `0x${'a'.repeat(64)}` }),
        },
      );
      expect(confirmed.status).toBe(200);
      const broadcast = await governanceActionStore.get(prepared.body.data.actionId);
      expect(broadcast?.status).toBe('broadcast_pending_verification');
      expect(broadcast?.audit.reconciliationFreezeRequest).toMatchObject({
        request: { requestId: request.requestId },
      });
      const statusReply = await fetch(
        `${baseUrl}/governance/freeze-requests/${request.requestId}`,
        {
          headers: { Authorization: 'Bearer sess-admin' },
        },
      );
      expect(statusReply.status).toBe(200);
      expect((await statusReply.json()).data).toMatchObject({
        request: { requestId: request.requestId },
        review: { decision: 'approved', reviewedBy: 'account:acct-admin' },
        action: { actionId: prepared.body.data.actionId, status: 'broadcast_pending_verification' },
      });
      const events = await db.runtime.query(`SELECT event_type FROM audit_log
        WHERE event_type IN ('governance.freeze_request.approved', 'governance.action.prepared')`);
      expect(events.rows.map((row) => row.event_type).sort()).toEqual([
        'governance.action.prepared',
        'governance.freeze_request.approved',
      ]);
      expect(
        (await call(rejected.requestId, 'review', { decision: 'rejected' }, 'rejected')).status,
      ).toBe(200);
      expect((await call(rejected.requestId, 'prepare', {}, 'rejected-prepare')).status).toBe(409);
      await expect(
        db.runtime.query(
          `UPDATE reconciliation_freeze_reviews SET decision = 'approved'
        WHERE request_id = $1`,
          [rejected.requestId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });

  it('rolls back the human decision when its audit cannot be persisted', async () => {
    const db = await createUserActionEnginePostgres();
    const store = createPostgresFreezeReviewStore(db.runtime);
    const request = buildFreezeRequest(
      fixture.proof.opening.seal.manifest,
      fixture.proof.opening.seal.manifest.containments[0],
    );
    try {
      await expect(
        store.review({
          request,
          decision: 'approved',
          actor: 'account:reviewer',
          reason: 'Critical drift',
          ticketRef: 'INC-951',
          requestId: 'audit-failure',
          audit: async () => {
            throw new Error('audit unavailable');
          },
        }),
      ).rejects.toThrow('audit unavailable');
      expect(await store.get(request.requestId)).toBeNull();
    } finally {
      await db.close();
    }
  });
});

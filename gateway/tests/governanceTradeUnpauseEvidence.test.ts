/** SPDX-License-Identifier: Apache-2.0 */
import type { UnpauseProposalState } from '../src/core/governanceStatusService';
import { createContainmentEvidenceService } from '../src/core/containmentEvidence';
import { encodeBytes32String } from 'ethers';
import {
  EVIDENCE_CONTEXT,
  EVIDENCE_KEYS,
  INCIDENT_REF,
  recoveryBundle,
  attestResponse,
  servingFetch,
} from './support/reconciliationBundles';
import { startGovernanceEvidenceServer as startServer } from './support/governanceEvidenceHarness';
const SIGNER = '0x00000000000000000000000000000000000000aa';

async function approve(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl}/governance/unpause/proposal/approve/prepare`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer sess-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      signerWallet: SIGNER,
      audit: {
        reason: 'Approve the governed unpause of a reconciled trade.',
        ticketRef: 'COTSEL-951',
        evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/COTSEL-951' }],
      },
    }),
  });
  return { status: response.status, body: await response.json() };
}

const TRADE_PROPOSAL: UnpauseProposalState = {
  hasActiveProposal: true,
  approvalCount: 0,
  executed: false,
  scope: 'TRADE',
  tradeId: '42',
  incidentRef: INCIDENT_REF,
};

/** The real evidence service and verifier, fed signed bundles through fetch. */
function evidence(situation: Parameters<typeof recoveryBundle>[0]) {
  return createContainmentEvidenceService(
    {
      baseUrl: 'http://reconciliation.test',
      publicKeys: EVIDENCE_KEYS,
      timeoutMs: 1000,
      context: EVIDENCE_CONTEXT,
      maxAgeSeconds: 900,
    },
    servingFetch(recoveryBundle(situation)),
  );
}

describe('trade-scoped unpause approval is decided from signed reconciliation evidence (R02)', () => {
  it('Q2: prepares when the proposal incident has a verified, signed clearance', async () => {
    const { server, baseUrl } = await startServer(TRADE_PROPOSAL, evidence('cleared'));
    try {
      const result = await approve(baseUrl, 'trade-unpause-cleared');
      expect(result.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('Q1: prepares the normal quorum unpause when reconciliation positively has no containment', async () => {
    const { server, baseUrl } = await startServer(
      { ...TRADE_PROPOSAL, incidentRef: encodeBytes32String('OPS-20261124-MAINT') },
      evidence('no_containment'),
    );
    try {
      expect((await approve(baseUrl, 'trade-unpause-q1')).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('refuses replay of an otherwise valid response from a different action lookup', async () => {
    let captured: Response | undefined;
    const live = servingFetch(recoveryBundle('no_containment'));
    const fetchReplay = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!captured) captured = await live(input, init);
      return captured.clone();
    }) as typeof fetch;
    const service = createContainmentEvidenceService(
      {
        baseUrl: 'http://reconciliation.test',
        publicKeys: EVIDENCE_KEYS,
        timeoutMs: 1000,
        context: EVIDENCE_CONTEXT,
        maxAgeSeconds: 900,
      },
      fetchReplay,
    );
    expect(
      (
        await service.requireRecovery({
          tradeId: '42',
          incidentRef: encodeBytes32String('manual-pause'),
        })
      ).decision,
    ).toBe('no_reconciliation_containment');
    await expect(
      service.requireRecovery({ tradeId: '42', incidentRef: encodeBytes32String('manual-pause') }),
    ).rejects.toMatchObject({ details: { detail: 'action_attestation_invalid' } });
  });

  it('rechecks recovery immediately before handing the transaction to the wallet', async () => {
    let reads = 0;
    const service = createContainmentEvidenceService(
      {
        baseUrl: 'http://reconciliation.test',
        publicKeys: EVIDENCE_KEYS,
        timeoutMs: 1000,
        context: EVIDENCE_CONTEXT,
        maxAgeSeconds: 900,
      },
      (async (input) =>
        new Response(
          JSON.stringify(
            await attestResponse(
              recoveryBundle(++reads === 1 ? 'cleared' : 'contained') as object,
              String(input),
            ),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )) as typeof fetch,
    );
    const { server, baseUrl } = await startServer(TRADE_PROPOSAL, service);
    try {
      const response = await approve(baseUrl, 'changed-before-handoff');
      expect(response.status).toBe(409);
      expect(response.body.error.details.reason).toBe('containment_not_cleared');
    } finally {
      server.close();
    }
  });

  it.each([
    ['still contained', 'contained', TRADE_PROPOSAL, 409, 'containment_not_cleared'],
    [
      'another incident',
      'cleared',
      { ...TRADE_PROPOSAL, incidentRef: encodeBytes32String('RECON-20261124-OTHER001') },
      409,
      'incident_mismatch',
    ],
    [
      'a RECON- incident reconciliation does not hold',
      'no_containment',
      TRADE_PROPOSAL,
      409,
      'reconciliation_incident_without_containment',
    ],
    ['stale evidence', 'stale', TRADE_PROPOSAL, 503, 'reconciliation_evidence_stale'],
  ] as const)(
    'refuses %s before anything is prepared',
    async (label, situation, proposal, status, reason) => {
      const { server, baseUrl } = await startServer(proposal, evidence(situation));
      try {
        const result = await approve(baseUrl, `trade-unpause-${label.replace(/\W+/gu, '-')}`);
        expect(result.status).toBe(status);
        expect(result.body.error.details).toMatchObject({ reason, tradeId: '42' });
      } finally {
        server.close();
      }
    },
  );

  it('fails closed when the gateway has no reconciliation evidence configured', async () => {
    const { server, baseUrl } = await startServer(TRADE_PROPOSAL, undefined);
    try {
      const result = await approve(baseUrl, 'trade-unpause-unconfigured');
      expect(result.status).toBe(503);
      expect(result.body.error.details).toMatchObject({
        reason: 'reconciliation_evidence_unconfigured',
      });
    } finally {
      server.close();
    }
  });

  it('does not consult reconciliation for a global unpause', async () => {
    const service = evidence('contained');
    const spy = jest.spyOn(service, 'requireRecovery');
    const { server, baseUrl } = await startServer(
      { ...TRADE_PROPOSAL, scope: 'GLOBAL', tradeId: '0', incidentRef: null },
      service,
    );
    try {
      expect((await approve(baseUrl, 'global-unpause')).status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

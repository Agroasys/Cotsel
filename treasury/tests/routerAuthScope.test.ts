import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { RequestHandler } from 'express';
import { TreasuryController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';

function buildAuthMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.header('x-test-auth') === 'ok') {
      next();
      return;
    }

    res.status(401).json({ success: false, error: 'Unauthorized' });
  };
}

function buildMutationAuthMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.header('x-test-mutation-auth') === 'ok') {
      next();
      return;
    }

    res.status(403).json({ success: false, error: 'Internal mutation caller required' });
  };
}

describe('treasury router auth scope', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());

    const controller = {
      ingest: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { ingested: true } });
      },
      listEntries: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      listEntryAccounting: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      getEntryAccounting: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      getTreasuryPartnerHandoff: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      appendState: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { updated: true } });
      },
      upsertTreasuryPartnerHandoff: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { stored: true } });
      },
      appendTreasuryPartnerHandoffEvidence: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { stored: true } });
      },
      createEntryRealization: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, data: { realized: true } });
      },
      upsertBankConfirmation: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { confirmed: true } });
      },
      listAccountingPeriods: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      getAccountingPeriodRollforward: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      getAccountingPeriodClosePacket: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      createAccountingPeriod: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, data: { created: true } });
      },
      requestAccountingPeriodClose: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { pendingClose: true } });
      },
      closeAccountingPeriod: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { closed: true } });
      },
      listSweepBatches: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      createSweepBatch: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, data: { created: true } });
      },
      getSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      getSweepBatchTrace: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      addSweepBatchEntry: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, data: { allocated: true } });
      },
      requestSweepBatchApproval: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { requested: true } });
      },
      approveSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { approved: true } });
      },
      markSweepBatchExecuted: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { executed: true } });
      },
      recordPartnerHandoff: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { handedOff: true } });
      },
      closeSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { closed: true } });
      },
      upsertDeposit: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { stored: true } });
      },
      getReconciliationControlSummary: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      exportEntries: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
    } as unknown as TreasuryController;

    app.use(
      '/api/treasury/v1',
      createRouter(controller, {
        authMiddleware: buildAuthMiddleware(),
        mutationAuthMiddleware: buildMutationAuthMiddleware(),
      }),
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test('unauthenticated read route is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/entries`);
    expect(response.status).toBe(401);
  });

  test('authenticated read route succeeds', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/entries`, {
      headers: {
        'x-test-auth': 'ok',
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
      }),
    );
  });

  test('legacy public mutation routes are removed', async () => {
    const response = await fetch(`${baseUrl}/api/treasury/v1/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rampReference: 'ramp-1' }),
    });

    expect(response.status).toBe(404);
  });

  test('internal mutation route requires both auth and internal mutation caller context', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/treasury/v1/internal/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rampReference: 'ramp-1' }),
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(`${baseUrl}/api/treasury/v1/internal/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'ok',
      },
      body: JSON.stringify({ rampReference: 'ramp-1' }),
    });
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/api/treasury/v1/internal/deposits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'ok',
        'x-test-mutation-auth': 'ok',
      },
      body: JSON.stringify({ rampReference: 'ramp-1' }),
    });
    expect(allowed.status).toBe(200);
  });

  test('external handoff mutation requires the same internal auth boundary as other treasury writes', async () => {
    const unauthenticated = await fetch(
      `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/external-handoff`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partnerName: 'licensed-counterparty',
          partnerReference: 'handoff-1',
          handoffStatus: 'ACKNOWLEDGED',
        }),
      },
    );
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(
      `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/external-handoff`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-auth': 'ok',
        },
        body: JSON.stringify({
          partnerName: 'licensed-counterparty',
          partnerReference: 'handoff-1',
          handoffStatus: 'ACKNOWLEDGED',
        }),
      },
    );
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(
      `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/external-handoff`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-auth': 'ok',
          'x-test-mutation-auth': 'ok',
        },
        body: JSON.stringify({
          partnerName: 'licensed-counterparty',
          partnerReference: 'handoff-1',
          handoffStatus: 'ACKNOWLEDGED',
        }),
      },
    );
    expect(allowed.status).toBe(200);
  });

  test('entry partner handoff evidence mutation requires the same internal auth boundary as other treasury writes', async () => {
    const unauthenticated = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/11/partner-handoff/evidence`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partnerCode: 'bridge',
          providerEventId: 'evt-1',
          eventType: 'transfer.updated',
          partnerStatus: 'COMPLETED',
          observedAt: '2026-04-17T09:10:00.000Z',
        }),
      },
    );
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/11/partner-handoff/evidence`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-auth': 'ok',
        },
        body: JSON.stringify({
          partnerCode: 'bridge',
          providerEventId: 'evt-1',
          eventType: 'transfer.updated',
          partnerStatus: 'COMPLETED',
          observedAt: '2026-04-17T09:10:00.000Z',
        }),
      },
    );
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/11/partner-handoff/evidence`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-auth': 'ok',
          'x-test-mutation-auth': 'ok',
        },
        body: JSON.stringify({
          partnerCode: 'bridge',
          providerEventId: 'evt-1',
          eventType: 'transfer.updated',
          partnerStatus: 'COMPLETED',
          observedAt: '2026-04-17T09:10:00.000Z',
        }),
      },
    );
    expect(allowed.status).toBe(200);
  });
});

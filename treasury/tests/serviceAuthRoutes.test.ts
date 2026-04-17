import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createRouter } from '../src/api/routes';
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  signServiceAuthCanonicalString,
} from '../src/auth/serviceAuth';

type ServiceAuthRequest = Request & {
  serviceAuth?: {
    apiKeyId: string;
  };
};

function createSignedRequestParts(options?: {
  method?: string;
  path?: string;
  query?: string;
  body?: Buffer;
  apiKey?: string;
  timestamp?: string;
  nonce?: string;
  secret?: string;
  signatureOverride?: string;
}) {
  const method = options?.method ?? 'POST';
  const path = options?.path ?? '/api/treasury/v1/internal/ingest';
  const query = options?.query ?? '';
  const body = options?.body ?? Buffer.from(JSON.stringify({ entryId: 'entry-1' }));
  const timestamp = options?.timestamp ?? '1700000000';
  const nonce = options?.nonce ?? 'nonce-1';
  const apiKey = options?.apiKey ?? 'svc-a';
  const secret = options?.secret ?? 'secret-a';
  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = buildServiceAuthCanonicalString({
    method,
    path,
    query,
    bodySha256,
    timestamp,
    nonce,
  });
  const signature = options?.signatureOverride ?? signServiceAuthCanonicalString(secret, canonical);

  return {
    body,
    bodyText: body.toString('utf8'),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-agroasys-timestamp': timestamp,
      'x-agroasys-nonce': nonce,
      'x-agroasys-signature': signature,
    },
  };
}

describe('treasury service-authenticated routes', () => {
  let server: Server;
  let baseUrl: string;
  let consumeNonce: jest.MockedFunction<
    (apiKey: string, nonce: string, ttlSeconds: number) => Promise<boolean>
  >;

  const lookupApiKey = (apiKey: string) => {
    if (apiKey === 'svc-a') {
      return { id: 'svc-a', secret: 'secret-a', active: true };
    }

    return undefined;
  };

  beforeEach(async () => {
    consumeNonce = jest.fn().mockResolvedValue(true);
    const authMiddleware = createServiceAuthMiddleware({
      enabled: true,
      maxSkewSeconds: 300,
      nonceTtlSeconds: 600,
      lookupApiKey,
      consumeNonce,
      nowSeconds: () => 1700000000,
    });
    const mutationAuthMiddleware = (req: ServiceAuthRequest, res: Response, next: () => void) => {
      if (req.serviceAuth?.apiKeyId === 'svc-a') {
        next();
        return;
      }

      res.status(403).json({ success: false, error: 'Internal mutation caller required' });
    };

    const controller = {
      ingest: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'ingest' });
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
      appendState: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { updated: true } });
      },
      createEntryRealization: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, route: 'realization' });
      },
      upsertBankConfirmation: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'bank-confirmation' });
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
        res.status(201).json({ success: true, route: 'periods' });
      },
      requestAccountingPeriodClose: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'period-request-close' });
      },
      closeAccountingPeriod: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'period-close' });
      },
      listSweepBatches: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      createSweepBatch: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, route: 'batch-create' });
      },
      getSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      getSweepBatchTrace: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      addSweepBatchEntry: (_req: Request, res: Response) => {
        res.status(201).json({ success: true, route: 'batch-entry' });
      },
      requestSweepBatchApproval: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'batch-request-approval' });
      },
      approveSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'batch-approve' });
      },
      markSweepBatchExecuted: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'batch-match-execution' });
      },
      recordPartnerHandoff: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'external-handoff' });
      },
      closeSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'batch-close' });
      },
      upsertDeposit: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: 'deposits' });
      },
      getReconciliationControlSummary: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      exportEntries: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
    };

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buffer) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
        },
      }),
    );
    app.use(
      '/api/treasury/v1',
      createRouter(controller as never, { authMiddleware, mutationAuthMiddleware }),
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

  test('valid signed ingest request reaches the route once', async () => {
    const signed = createSignedRequestParts({ nonce: 'treasury-route-nonce' });

    const response = await fetch(`${baseUrl}/api/treasury/v1/internal/ingest`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'ingest',
      }),
    );
    expect(consumeNonce).toHaveBeenCalledWith('svc-a', 'treasury-route-nonce', 600);
  });

  test('replayed ingest request is rejected before controller runs', async () => {
    consumeNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const signed = createSignedRequestParts({ nonce: 'treasury-replay' });

    const firstResponse = await fetch(`${baseUrl}/api/treasury/v1/internal/ingest`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    const secondResponse = await fetch(`${baseUrl}/api/treasury/v1/internal/ingest`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(401);
    await expect(secondResponse.json()).resolves.toEqual(
      expect.objectContaining({
        code: 'AUTH_NONCE_REPLAY',
        error: 'Replay detected for nonce',
      }),
    );
  });

  test('invalid signature is rejected at the route boundary', async () => {
    const signed = createSignedRequestParts({
      nonce: 'treasury-invalid-signature',
      signatureOverride: 'f'.repeat(64),
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/internal/ingest`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    expect(response.status).toBe(401);
    expect(consumeNonce).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: 'AUTH_INVALID_SIGNATURE',
        error: 'Invalid signature',
      }),
    );
  });

  test('stale timestamp is rejected at the route boundary', async () => {
    const signed = createSignedRequestParts({
      nonce: 'treasury-stale',
      timestamp: '1699999600',
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/internal/ingest`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    expect(response.status).toBe(401);
    expect(consumeNonce).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: 'AUTH_TIMESTAMP_SKEW',
        error: 'Timestamp outside allowed skew window',
      }),
    );
  });

  test('nonce persistence failure returns auth unavailable', async () => {
    consumeNonce.mockRejectedValue(new Error('redis unavailable'));
    const signed = createSignedRequestParts({ nonce: 'treasury-db-error' });

    const response = await fetch(`${baseUrl}/api/treasury/v1/internal/ingest`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: 'AUTH_UNAVAILABLE',
        error: 'Authentication service unavailable',
      }),
    );
  });

  test('valid signed deposit request reaches the route once', async () => {
    const body = Buffer.from(
      JSON.stringify({
        rampReference: 'ramp-1',
        tradeId: 'trade-1',
        depositState: 'FUNDED',
        sourceAmount: '100',
        currency: 'USD',
        expectedAmount: '100',
        expectedCurrency: 'USD',
        observedAt: '2026-03-26T00:00:00.000Z',
        providerEventId: 'provider-event-1',
        providerAccountRef: 'acct-1',
      }),
    );
    const signed = createSignedRequestParts({
      path: '/api/treasury/v1/internal/deposits',
      body,
      nonce: 'treasury-deposit-route-nonce',
    });

    const response = await fetch(`${baseUrl}/api/treasury/v1/internal/deposits`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.bodyText,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'deposits',
      }),
    );
    expect(consumeNonce).toHaveBeenCalledWith('svc-a', 'treasury-deposit-route-nonce', 600);
  });

  test('valid signed bank confirmation request reaches the route once', async () => {
    const body = Buffer.from(
      JSON.stringify({
        bankReference: 'bank-1',
        bankState: 'CONFIRMED',
        confirmedAt: '2026-03-26T00:00:00.000Z',
        source: 'bank:webhook',
        actor: 'Treasury Operator',
      }),
    );
    const signed = createSignedRequestParts({
      path: '/api/treasury/v1/internal/entries/11/bank-confirmation',
      body,
      nonce: 'treasury-bank-confirmation-nonce',
    });

    const response = await fetch(
      `${baseUrl}/api/treasury/v1/internal/entries/11/bank-confirmation`,
      {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'bank-confirmation',
      }),
    );
    expect(consumeNonce).toHaveBeenCalledWith('svc-a', 'treasury-bank-confirmation-nonce', 600);
  });

  test('valid signed external handoff request reaches the canonical internal route once', async () => {
    const body = Buffer.from(
      JSON.stringify({
        partnerName: 'licensed-counterparty',
        partnerReference: 'handoff-1',
        handoffStatus: 'ACKNOWLEDGED',
      }),
    );
    const signed = createSignedRequestParts({
      path: '/api/treasury/v1/internal/sweep-batches/11/external-handoff',
      body,
      nonce: 'treasury-external-handoff-nonce',
    });

    const response = await fetch(
      `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/external-handoff`,
      {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'external-handoff',
      }),
    );
    expect(consumeNonce).toHaveBeenCalledWith('svc-a', 'treasury-external-handoff-nonce', 600);
  });

  test('legacy partner-handoff alias remains wired to the same internal controller', async () => {
    const body = Buffer.from(
      JSON.stringify({
        partnerName: 'licensed-counterparty',
        partnerReference: 'handoff-legacy-1',
        handoffStatus: 'ACKNOWLEDGED',
      }),
    );
    const signed = createSignedRequestParts({
      path: '/api/treasury/v1/internal/sweep-batches/11/partner-handoff',
      body,
      nonce: 'treasury-legacy-partner-handoff-nonce',
    });

    const response = await fetch(
      `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/partner-handoff`,
      {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        route: 'external-handoff',
      }),
    );
    expect(consumeNonce).toHaveBeenCalledWith(
      'svc-a',
      'treasury-legacy-partner-handoff-nonce',
      600,
    );
  });
});

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

jest.mock('../src/database/queries', () => ({
  ...jest.requireActual('../src/database/queries'),
  updateAccountingPeriodStatus: jest.fn(),
  getSweepBatchDetail: jest.fn(),
  updateSweepBatchStatus: jest.fn(),
}));

jest.mock('../src/core/closeReporting', () => ({
  loadTreasuryAccountingPeriodClosePacket: jest.fn(),
  loadTreasuryBatchTraceReport: jest.fn(),
  renderTreasuryAccountingPeriodClosePacketMarkdown: jest.fn().mockReturnValue('# close packet'),
}));

type ServiceAuthRequest = Request & {
  serviceAuth?: {
    apiKeyId: string;
  };
};

function createMutationAuthMiddleware(allowedApiKeyId: string) {
  return (req: ServiceAuthRequest, res: Response, next: () => void) => {
    if (req.serviceAuth?.apiKeyId === allowedApiKeyId) {
      next();
      return;
    }

    res.status(403).json({ success: false, error: 'Internal mutation caller required' });
  };
}

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
  const nonce = options?.nonce ?? crypto.randomUUID();
  const apiKey = options?.apiKey ?? 'svc-admin';
  const secret = options?.secret ?? 'secret-admin';
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

describe('admin bridge route safety — close/sweep consumption paths', () => {
  let server: Server;
  let baseUrl: string;
  let consumeNonce: jest.MockedFunction<
    (apiKey: string, nonce: string, ttlSeconds: number) => Promise<boolean>
  >;
  const allowedMutationCallerApiKeyId = 'svc-admin';
  const unauthorizedApiKeyId = 'svc-readonly';

  const lookupApiKey = (apiKey: string) => {
    if (apiKey === allowedMutationCallerApiKeyId) {
      return { id: allowedMutationCallerApiKeyId, secret: 'secret-admin', active: true };
    }
    if (apiKey === unauthorizedApiKeyId) {
      return { id: unauthorizedApiKeyId, secret: 'secret-readonly', active: true };
    }
    return undefined;
  };

  let closeAccountingPeriodHandler: jest.Mock;
  let requestAccountingPeriodCloseHandler: jest.Mock;
  let createAccountingPeriodHandler: jest.Mock;
  let createSweepBatchHandler: jest.Mock;
  let addSweepBatchEntryHandler: jest.Mock;
  let requestSweepBatchApprovalHandler: jest.Mock;
  let approveSweepBatchHandler: jest.Mock;
  let markSweepBatchExecutedHandler: jest.Mock;
  let closeSweepBatchHandler: jest.Mock;
  let recordPartnerHandoffHandler: jest.Mock;
  let ingestHandler: jest.Mock;

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
    const mutationAuthMiddleware = createMutationAuthMiddleware(allowedMutationCallerApiKeyId);

    closeAccountingPeriodHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'period-close' });
    });
    requestAccountingPeriodCloseHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'period-request-close' });
    });
    createAccountingPeriodHandler = jest.fn((_req: Request, res: Response) => {
      res.status(201).json({ success: true, route: 'periods' });
    });
    createSweepBatchHandler = jest.fn((_req: Request, res: Response) => {
      res.status(201).json({ success: true, route: 'batch-create' });
    });
    addSweepBatchEntryHandler = jest.fn((_req: Request, res: Response) => {
      res.status(201).json({ success: true, route: 'batch-entry' });
    });
    requestSweepBatchApprovalHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'batch-request-approval' });
    });
    approveSweepBatchHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'batch-approve' });
    });
    markSweepBatchExecutedHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'batch-match-execution' });
    });
    closeSweepBatchHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'batch-close' });
    });
    recordPartnerHandoffHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'external-handoff' });
    });
    ingestHandler = jest.fn((_req: Request, res: Response) => {
      res.status(200).json({ success: true, route: 'ingest' });
    });

    const controller = {
      ingest: ingestHandler,
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
        res.status(201).json({ success: true, route: 'realization' });
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
      createAccountingPeriod: createAccountingPeriodHandler,
      requestAccountingPeriodClose: requestAccountingPeriodCloseHandler,
      closeAccountingPeriod: closeAccountingPeriodHandler,
      listSweepBatches: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: [] });
      },
      createSweepBatch: createSweepBatchHandler,
      getSweepBatch: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      getSweepBatchTrace: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: null });
      },
      addSweepBatchEntry: addSweepBatchEntryHandler,
      requestSweepBatchApproval: requestSweepBatchApprovalHandler,
      approveSweepBatch: approveSweepBatchHandler,
      markSweepBatchExecuted: markSweepBatchExecutedHandler,
      recordPartnerHandoff: recordPartnerHandoffHandler,
      closeSweepBatch: closeSweepBatchHandler,
      upsertDeposit: (_req: Request, res: Response) => {
        res.status(200).json({ success: true, data: { stored: true } });
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

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Close/Sweep route auth — wrong role / missing capability rejected
  // ──────────────────────────────────────────────────────────────────────────

  describe('close route auth — wrong role rejected', () => {
    test('period close rejects callers with valid auth but wrong mutation role', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:rogue', closeReason: 'Q1 close' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'close-wrong-role',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          success: false,
          error: 'Internal mutation caller required',
        }),
      );
      expect(closeAccountingPeriodHandler).not.toHaveBeenCalled();
    });

    test('period request-close rejects callers with valid auth but wrong mutation role', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:rogue' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/request-close',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'req-close-wrong-role',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/request-close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(403);
      expect(requestAccountingPeriodCloseHandler).not.toHaveBeenCalled();
    });

    test('period close with no auth headers is rejected at the auth boundary', async () => {
      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'user:rogue' }),
        },
      );

      expect(response.status).toBe(401);
      expect(closeAccountingPeriodHandler).not.toHaveBeenCalled();
    });

    test('period close with correct admin credentials reaches the controller', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin', closeReason: 'Q1 close' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        nonce: 'close-valid-admin',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(200);
      expect(closeAccountingPeriodHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Sweep batch operations — unauthorized access rejected
  // ──────────────────────────────────────────────────────────────────────────

  describe('sweep batch operations — unauthorized access rejected', () => {
    test('create sweep batch rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(
        JSON.stringify({
          batchKey: 'batch-rogue',
          accountingPeriodId: 7,
          assetSymbol: 'USDC',
          expectedTotalRaw: '1000',
          createdBy: 'user:rogue',
        }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'batch-create-wrong-role',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(403);
      expect(createSweepBatchHandler).not.toHaveBeenCalled();
    });

    test('add sweep batch entry rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(
        JSON.stringify({ ledgerEntryId: 501, allocatedBy: 'user:rogue', entryAmountRaw: '100' }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/entries',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'batch-entry-wrong-role',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches/11/entries`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(403);
      expect(addSweepBatchEntryHandler).not.toHaveBeenCalled();
    });

    test('request sweep batch approval rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:rogue' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/request-approval',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'batch-approval-wrong-role',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/request-approval`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(403);
      expect(requestSweepBatchApprovalHandler).not.toHaveBeenCalled();
    });

    test('approve sweep batch rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:rogue' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/approve',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'batch-approve-wrong-role',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches/11/approve`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(403);
      expect(approveSweepBatchHandler).not.toHaveBeenCalled();
    });

    test('mark sweep batch executed rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(
        JSON.stringify({ actor: 'user:rogue', matchedSweepTxHash: '0xfake' }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/match-execution',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'batch-exec-wrong-role',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/match-execution`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(403);
      expect(markSweepBatchExecutedHandler).not.toHaveBeenCalled();
    });

    test('close sweep batch rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:rogue' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/close',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'batch-close-wrong-role',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches/11/close`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(403);
      expect(closeSweepBatchHandler).not.toHaveBeenCalled();
    });

    test('external handoff rejects callers with wrong mutation role', async () => {
      const body = Buffer.from(
        JSON.stringify({
          partnerName: 'licensed-counterparty',
          partnerReference: 'handoff-rogue',
          handoffStatus: 'ACKNOWLEDGED',
        }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/external-handoff',
        body,
        apiKey: unauthorizedApiKeyId,
        secret: 'secret-readonly',
        nonce: 'handoff-wrong-role',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/sweep-batches/11/external-handoff`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(403);
      expect(recordPartnerHandoffHandler).not.toHaveBeenCalled();
    });

    test('sweep batch operations succeed with correct admin credentials', async () => {
      const body = Buffer.from(
        JSON.stringify({
          batchKey: 'batch-valid',
          accountingPeriodId: 7,
          assetSymbol: 'USDC',
          expectedTotalRaw: '1000',
          createdBy: 'user:admin',
        }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches',
        body,
        nonce: 'batch-create-valid',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(201);
      expect(createSweepBatchHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Service auth routes — replay protection, stale request rejection
  // ──────────────────────────────────────────────────────────────────────────

  describe('service auth — replay protection on close/sweep paths', () => {
    test('replayed period close request is rejected before controller runs', async () => {
      consumeNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin', closeReason: 'Q1 close' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        nonce: 'close-replay',
      });

      const firstResponse = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      const secondResponse = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(401);
      await expect(secondResponse.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_NONCE_REPLAY',
          error: 'Replay detected for nonce',
        }),
      );
      expect(closeAccountingPeriodHandler).toHaveBeenCalledTimes(1);
    });

    test('replayed sweep batch create request is rejected before controller runs', async () => {
      consumeNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const body = Buffer.from(
        JSON.stringify({
          batchKey: 'batch-replay',
          accountingPeriodId: 7,
          assetSymbol: 'USDC',
          expectedTotalRaw: '500',
          createdBy: 'user:admin',
        }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches',
        body,
        nonce: 'batch-replay',
      });

      const firstResponse = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      const secondResponse = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(401);
      await expect(secondResponse.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_NONCE_REPLAY',
        }),
      );
      expect(createSweepBatchHandler).toHaveBeenCalledTimes(1);
    });

    test('stale timestamp on period close is rejected at the route boundary', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin', closeReason: 'Q1 close' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        nonce: 'close-stale',
        timestamp: '1699999600',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(401);
      expect(consumeNonce).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_TIMESTAMP_SKEW',
          error: 'Timestamp outside allowed skew window',
        }),
      );
      expect(closeAccountingPeriodHandler).not.toHaveBeenCalled();
    });

    test('stale timestamp on sweep batch close is rejected at the route boundary', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/close',
        body,
        nonce: 'batch-close-stale',
        timestamp: '1699999600',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches/11/close`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(401);
      expect(consumeNonce).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_TIMESTAMP_SKEW',
        }),
      );
      expect(closeSweepBatchHandler).not.toHaveBeenCalled();
    });

    test('invalid signature on period close is rejected at the route boundary', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        nonce: 'close-invalid-sig',
        signatureOverride: 'f'.repeat(64),
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(401);
      expect(consumeNonce).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_INVALID_SIGNATURE',
          error: 'Invalid signature',
        }),
      );
      expect(closeAccountingPeriodHandler).not.toHaveBeenCalled();
    });

    test('invalid signature on sweep batch approve is rejected at the route boundary', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/approve',
        body,
        nonce: 'approve-invalid-sig',
        signatureOverride: 'f'.repeat(64),
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches/11/approve`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(401);
      expect(consumeNonce).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_INVALID_SIGNATURE',
        }),
      );
      expect(approveSweepBatchHandler).not.toHaveBeenCalled();
    });

    test('unknown API key on close route is rejected at the auth boundary', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:unknown' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        apiKey: 'svc-unknown',
        secret: 'secret-unknown',
        nonce: 'close-unknown-key',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(401);
      expect(closeAccountingPeriodHandler).not.toHaveBeenCalled();
    });

    test('nonce persistence failure on close route returns auth unavailable', async () => {
      consumeNonce.mockRejectedValue(new Error('redis unavailable'));
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/close',
        body,
        nonce: 'close-db-error',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          code: 'AUTH_UNAVAILABLE',
          error: 'Authentication service unavailable',
        }),
      );
      expect(closeAccountingPeriodHandler).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Complete admin bridge consumption path — authorized end-to-end
  // ──────────────────────────────────────────────────────────────────────────

  describe('authorized admin bridge paths reach controller exactly once', () => {
    test('create accounting period with valid admin credentials reaches controller', async () => {
      const body = Buffer.from(
        JSON.stringify({
          periodKey: '2026-Q1',
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2026-03-31T23:59:59.000Z',
          createdBy: 'user:admin',
        }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods',
        body,
        nonce: 'period-create-valid',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/accounting-periods`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(201);
      expect(createAccountingPeriodHandler).toHaveBeenCalledTimes(1);
      expect(consumeNonce).toHaveBeenCalledWith('svc-admin', 'period-create-valid', 600);
    });

    test('request period close with valid admin credentials reaches controller', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/accounting-periods/7/request-close',
        body,
        nonce: 'req-close-valid',
      });

      const response = await fetch(
        `${baseUrl}/api/treasury/v1/internal/accounting-periods/7/request-close`,
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.bodyText,
        },
      );

      expect(response.status).toBe(200);
      expect(requestAccountingPeriodCloseHandler).toHaveBeenCalledTimes(1);
    });

    test('close sweep batch with valid admin credentials reaches controller', async () => {
      const body = Buffer.from(JSON.stringify({ actor: 'user:admin' }));
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/close',
        body,
        nonce: 'batch-close-valid',
      });

      const response = await fetch(`${baseUrl}/api/treasury/v1/internal/sweep-batches/11/close`, {
        method: 'POST',
        headers: signed.headers,
        body: signed.bodyText,
      });

      expect(response.status).toBe(200);
      expect(closeSweepBatchHandler).toHaveBeenCalledTimes(1);
    });

    test('external handoff with valid admin credentials reaches controller', async () => {
      const body = Buffer.from(
        JSON.stringify({
          partnerName: 'licensed-counterparty',
          partnerReference: 'handoff-valid',
          handoffStatus: 'ACKNOWLEDGED',
        }),
      );
      const signed = createSignedRequestParts({
        path: '/api/treasury/v1/internal/sweep-batches/11/external-handoff',
        body,
        nonce: 'handoff-valid',
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
      expect(recordPartnerHandoffHandler).toHaveBeenCalledTimes(1);
      expect(consumeNonce).toHaveBeenCalledWith('svc-admin', 'handoff-valid', 600);
    });
  });
});

describe('admin bridge route safety — state guard tests', () => {
  // These tests use the real TreasuryController to verify that state guards
  // at the controller layer reject invalid state transitions.

  process.env.PORT = process.env.PORT || '3200';
  process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.DB_PORT || '5432';
  process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
  process.env.DB_USER = process.env.DB_USER || 'postgres';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
  process.env.INDEXER_GRAPHQL_URL =
    process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

  type TreasuryControllerType = typeof import('../src/api/controller').TreasuryController;
  type QueriesModule = typeof import('../src/database/queries');
  type CloseReportingModule = typeof import('../src/core/closeReporting');

  type MockResponse = Response & {
    status: jest.MockedFunction<(code: number) => MockResponse>;
    json: jest.MockedFunction<(body: unknown) => MockResponse>;
  };

  type CloseAccountingPeriodRequest = Request<
    { periodId: string },
    unknown,
    { actor: string; closeReason?: string }
  >;

  type CloseSweepBatchRequest = Request<{ batchId: string }, unknown, { actor: string }>;

  let LoadedTreasuryController: TreasuryControllerType;
  let queriesModule: QueriesModule;
  let closeReportingModule: CloseReportingModule;

  function mockResponse(): MockResponse {
    const response = {} as MockResponse;
    response.status = jest.fn().mockReturnValue(response);
    response.json = jest.fn().mockReturnValue(response);
    return response;
  }

  beforeEach(async () => {
    jest.resetModules();
    ({ TreasuryController: LoadedTreasuryController } = await import('../src/api/controller'));
    queriesModule = await import('../src/database/queries');
    closeReportingModule = await import('../src/core/closeReporting');
    jest.clearAllMocks();
  });

  test('closeAccountingPeriod rejects when close packet indicates blocking issues', async () => {
    jest.mocked(closeReportingModule.loadTreasuryAccountingPeriodClosePacket).mockResolvedValue({
      period: {
        id: 7,
        period_key: '2026-Q1',
        starts_at: new Date('2026-01-01T00:00:00.000Z'),
        ends_at: new Date('2026-03-31T23:59:59.000Z'),
        status: 'PENDING_CLOSE',
        created_by: 'user:uid-admin',
        close_reason: null,
        pending_close_at: null,
        closed_at: null,
        closed_by: null,
        metadata: {},
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-03-31T23:00:00.000Z'),
      },
      generated_at: '2026-03-31T23:30:00.000Z',
      ready_for_close: false,
      rollforward: {
        period: {
          id: 7,
          period_key: '2026-Q1',
          starts_at: new Date('2026-01-01T00:00:00.000Z'),
          ends_at: new Date('2026-03-31T23:59:59.000Z'),
          status: 'PENDING_CLOSE',
          created_by: 'user:uid-admin',
          close_reason: null,
          pending_close_at: null,
          closed_at: null,
          closed_by: null,
          metadata: {},
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-03-31T23:00:00.000Z'),
        },
        generated_at: '2026-03-31T23:30:00.000Z',
        opening_held_raw: '0',
        new_accruals_raw: '0',
        allocated_to_batches_raw: '0',
        swept_onchain_raw: '0',
        handed_off_raw: '0',
        realized_raw: '0',
        ending_held_raw: '0',
        unresolved_exception_raw: '0',
        blocking_issue_count: 1,
        warning_issue_count: 0,
        blocking_issues: [],
        warning_issues: [],
      },
      reconciliation: {
        status: 'CLEAR',
        freshness: 'FRESH',
        latest_completed_run_key: 'run-1',
        latest_completed_run_at: '2026-03-31T23:00:00.000Z',
        stale_running_run_count: 0,
        blocked_reasons: [],
      },
      batches: [],
      blocking_issues: [
        {
          code: 'SWEEP_TX_UNMATCHED',
          severity: 'BLOCKING',
          owner: 'TREASURY',
          message: 'Sweep batch is marked executed without matched treasury claim evidence',
          trade_id: null,
          sweep_batch_id: 999,
          ledger_entry_id: null,
          details: { batchStatus: 'EXECUTED' },
        },
      ],
      warning_issues: [],
    });

    const controller = new LoadedTreasuryController();
    const req = {
      params: { periodId: '7' },
      body: { actor: 'user:uid-admin', closeReason: 'Quarter close review' },
    } as unknown as CloseAccountingPeriodRequest;
    const res = mockResponse();

    await controller.closeAccountingPeriod(req, res);

    expect(queriesModule.updateAccountingPeriodStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'CloseBlocked',
        message: expect.stringContaining('blocking treasury close issues remain'),
      }),
    );
  });

  test('closeAccountingPeriod succeeds when close packet is ready', async () => {
    jest.mocked(closeReportingModule.loadTreasuryAccountingPeriodClosePacket).mockResolvedValue({
      period: {
        id: 7,
        period_key: '2026-Q1',
        starts_at: new Date('2026-01-01T00:00:00.000Z'),
        ends_at: new Date('2026-03-31T23:59:59.000Z'),
        status: 'PENDING_CLOSE',
        created_by: 'user:uid-admin',
        close_reason: null,
        pending_close_at: null,
        closed_at: null,
        closed_by: null,
        metadata: {},
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-03-31T23:00:00.000Z'),
      },
      generated_at: '2026-03-31T23:30:00.000Z',
      ready_for_close: true,
      rollforward: {
        period: {
          id: 7,
          period_key: '2026-Q1',
          starts_at: new Date('2026-01-01T00:00:00.000Z'),
          ends_at: new Date('2026-03-31T23:59:59.000Z'),
          status: 'PENDING_CLOSE',
          created_by: 'user:uid-admin',
          close_reason: null,
          pending_close_at: null,
          closed_at: null,
          closed_by: null,
          metadata: {},
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-03-31T23:00:00.000Z'),
        },
        generated_at: '2026-03-31T23:30:00.000Z',
        opening_held_raw: '0',
        new_accruals_raw: '0',
        allocated_to_batches_raw: '0',
        swept_onchain_raw: '0',
        handed_off_raw: '0',
        realized_raw: '0',
        ending_held_raw: '0',
        unresolved_exception_raw: '0',
        blocking_issue_count: 0,
        warning_issue_count: 0,
        blocking_issues: [],
        warning_issues: [],
      },
      reconciliation: {
        status: 'CLEAR',
        freshness: 'FRESH',
        latest_completed_run_key: 'run-1',
        latest_completed_run_at: '2026-03-31T23:00:00.000Z',
        stale_running_run_count: 0,
        blocked_reasons: [],
      },
      batches: [],
      blocking_issues: [],
      warning_issues: [],
    });

    jest.mocked(queriesModule.updateAccountingPeriodStatus).mockResolvedValue({
      id: 7,
      period_key: '2026-Q1',
      status: 'CLOSED',
    } as never);

    const controller = new LoadedTreasuryController();
    const req = {
      params: { periodId: '7' },
      body: { actor: 'user:uid-admin', closeReason: 'Quarter close review' },
    } as unknown as CloseAccountingPeriodRequest;
    const res = mockResponse();

    await controller.closeAccountingPeriod(req, res);

    expect(queriesModule.updateAccountingPeriodStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        periodId: 7,
        status: 'CLOSED',
        actor: 'user:uid-admin',
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('closeSweepBatch rejects when partner handoff is not completed', async () => {
    jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue({
      batch: {
        id: 11,
        batch_key: 'batch-q1-001',
        status: 'HANDED_OFF',
      },
      entries: [],
      partnerHandoff: {
        id: 33,
        handoff_status: 'ACKNOWLEDGED',
      },
      totals: { allocatedAmountRaw: '100', entryCount: 1 },
    } as never);

    const controller = new LoadedTreasuryController();
    const req = {
      params: { batchId: '11' },
      body: { actor: 'user:uid-admin' },
    } as unknown as CloseSweepBatchRequest;
    const res = mockResponse();

    await controller.closeSweepBatch(req, res);

    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'CloseBlocked',
        message: expect.stringContaining('completed external handoff evidence'),
      }),
    );
  });

  test('closeSweepBatch rejects when entries are not fully realized', async () => {
    jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue({
      batch: {
        id: 11,
        batch_key: 'batch-q1-001',
        status: 'HANDED_OFF',
      },
      entries: [
        { ledger_entry_id: 501, accounting_state: 'SWEPT' },
        { ledger_entry_id: 502, accounting_state: 'REALIZED' },
      ],
      partnerHandoff: {
        id: 33,
        handoff_status: 'COMPLETED',
      },
      totals: { allocatedAmountRaw: '200', entryCount: 2 },
    } as never);

    const controller = new LoadedTreasuryController();
    const req = {
      params: { batchId: '11' },
      body: { actor: 'user:uid-admin' },
    } as unknown as CloseSweepBatchRequest;
    const res = mockResponse();

    await controller.closeSweepBatch(req, res);

    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'CloseBlocked',
        message: expect.stringContaining('unrealized'),
      }),
    );
  });

  test('closeSweepBatch rejects when batch is not found', async () => {
    jest.mocked(queriesModule.getSweepBatchDetail).mockResolvedValue(null as never);

    const controller = new LoadedTreasuryController();
    const req = {
      params: { batchId: '999' },
      body: { actor: 'user:uid-admin' },
    } as unknown as CloseSweepBatchRequest;
    const res = mockResponse();

    await controller.closeSweepBatch(req, res);

    expect(queriesModule.updateSweepBatchStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import {
  createServiceAuthMiddleware,
  parseServiceApiKeys,
  type NonceStore,
  type ServiceApiKey,
} from '@agroasys/shared-auth';
import { getAddress } from 'ethers';
import { validateManagedSignerTransaction } from '@agroasys/sdk';
import type { RelayerConfig } from './config';
import { RelayerError } from './errors';
import type { RelayerSigner } from './kmsRelayerSigner';
import { logger } from './logger';
import { validateSigningRequest } from './signingPolicy';

const MINIMUM_API_SECRET_BYTES = 32;

export interface RelayerAppDependencies {
  signer: RelayerSigner;
  authNonceStore: NonceStore;
  requestStore: NonceStore;
}

function apiKeyLookup(apiKeysJson: string): (id: string) => ServiceApiKey | undefined {
  const records = parseServiceApiKeys(apiKeysJson);
  if (!records.some((record) => record.active)) {
    throw new Error('RELAYER_API_KEYS_JSON must contain an active API key');
  }
  if (
    records.some((record) => Buffer.byteLength(record.secret, 'utf8') < MINIMUM_API_SECRET_BYTES)
  ) {
    throw new Error(
      `RELAYER_API_KEYS_JSON secrets must contain at least ${MINIMUM_API_SECRET_BYTES} bytes`,
    );
  }
  const keys = new Map(records.map((record) => [record.id, record]));
  return (id) => keys.get(id);
}

function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof RelayerError) {
    logger.warn('Relayer request rejected', {
      method: req.method,
      path: req.path,
      statusCode: error.statusCode,
      code: error.code,
    });
    res.status(error.statusCode).json({ success: false, code: error.code, error: error.message });
    return;
  }
  if (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as SyntaxError & { status?: number }).status === 400
  ) {
    res
      .status(400)
      .json({ success: false, code: 'INVALID_JSON', error: 'Request body is invalid' });
    return;
  }
  logger.error('Relayer request failed', {
    method: req.method,
    path: req.path,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(503).json({
    success: false,
    code: 'SIGNER_UNAVAILABLE',
    error: 'Relayer signer is unavailable',
  });
}

export function createRelayerApp(config: RelayerConfig, dependencies: RelayerAppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    express.json({
      limit: '32kb',
      strict: true,
      verify: (req, _res, buffer) => {
        (req as Request).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get('/api/relayer/health', (_req, res) => {
    res.status(200).json({ success: true, service: 'gasless-relayer' });
  });

  const authenticate = createServiceAuthMiddleware({
    enabled: true,
    maxSkewSeconds: config.authMaxSkewSeconds,
    nonceTtlSeconds: config.authNonceTtlSeconds,
    lookupApiKey: apiKeyLookup(config.apiKeysJson),
    consumeNonce: dependencies.authNonceStore.consume.bind(dependencies.authNonceStore),
    onAuthFailure: (reason) => logger.warn('Relayer authentication rejected', { reason }),
    onReplayReject: () => logger.warn('Relayer authentication replay rejected'),
  });
  app.use('/api/signers/gasless-relayer', authenticate);

  app.get('/api/signers/gasless-relayer/address', async (_req, res, next) => {
    try {
      const signerAddress = getAddress(await dependencies.signer.getAddress());
      if (signerAddress !== config.kmsExpectedAddress) {
        throw new Error('Relayer signer address differs from reviewed configuration');
      }
      res.status(200).json({ signerAddress });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/signers/gasless-relayer/sign-transaction', async (req, res, next) => {
    try {
      const request = validateSigningRequest(req.body, config);
      const accepted = await dependencies.requestStore.consume(
        'intent',
        request.requestId,
        config.requestReplayTtlSeconds,
      );
      if (!accepted) {
        throw new RelayerError(409, 'SIGNING_REQUEST_REPLAY', 'requestId was already consumed');
      }
      const signedTransaction = await dependencies.signer.signTransaction(request);
      const evidence = validateManagedSignerTransaction(signedTransaction, {
        requestId: request.requestId,
        signerAddress: request.signerAddress,
        ...request.transaction,
      });
      logger.info('Relayer transaction signed', {
        apiKeyId: req.serviceAuth?.apiKeyId,
        operation: request.operation,
        requestId: request.requestId,
        intentHash: request.intentHash,
        transactionHash: evidence.signedTransactionHash,
      });
      res.status(200).json({
        requestId: request.requestId,
        intentHash: request.intentHash,
        signerAddress: request.signerAddress,
        signedTransaction,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'Route not found' });
  });
  app.use(errorHandler);
  return app;
}

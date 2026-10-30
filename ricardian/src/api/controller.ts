import { Request, Response } from 'express';
import {
  CallerSafeError,
  correlationIdFor,
  failure,
  HttpError,
  requireObject,
  requireString,
  sendInternalFailure,
  success,
} from '@agroasys/shared-http';
import { createDocument, getDocument, getTenantDocument } from '../database/documentStore';
import { DocumentConflictError, DocumentNotFoundError, DocumentStoreError } from '../errors';
import {
  RicardianHashAttestation,
  RicardianHashResponse,
  RicardianHashRow,
  RicardianRegistrationRequest,
} from '../types';
import { resolveTenant, type TenantResolutionOptions } from '../auth/tenantBinding';
import { buildRicardianHash } from '../utils/hash';
import { Logger } from '../utils/logger';

function mapRowToResponse(row: RicardianHashRow, tenantId: string): RicardianHashResponse {
  return {
    id: row.id,
    requestId: row.request_id,
    tenantId,
    documentRef: row.document_ref,
    hash: row.hash,
    rulesVersion: row.rules_version,
    canonicalJson: row.canonical_json,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapRowToAttestation(row: RicardianHashRow): RicardianHashAttestation {
  return {
    hash: row.hash,
    rulesVersion: row.rules_version,
    registeredAt: row.created_at.toISOString(),
  };
}

function parseCreateHashBody(body: unknown): RicardianRegistrationRequest {
  const payload = requireObject(body, 'body') as unknown as RicardianRegistrationRequest;

  return {
    requestId:
      payload.requestId === undefined ? undefined : requireString(payload.requestId, 'requestId'),
    tenantId: payload.tenantId,
    documentRef: requireString(payload.documentRef, 'documentRef'),
    terms: requireObject(payload.terms, 'terms'),
    metadata:
      payload.metadata === undefined ? undefined : requireObject(payload.metadata, 'metadata'),
  };
}

function parseHashParam(value: unknown): string {
  const hash = requireString(value, 'hash').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new HttpError(400, 'ValidationError', 'Invalid hash format');
  }

  return hash;
}

/** Store and unexpected failures answer with a stable code; the raw error is only logged. */
function sendStoreFailure(req: Request, res: Response, error: unknown, operation: string): void {
  const storeCode = error instanceof DocumentStoreError ? error.code : undefined;
  sendInternalFailure(req, res, error, {
    log: (correlationId, cause) =>
      Logger.error('Ricardian request failed', {
        operation,
        correlationId,
        code: storeCode ?? null,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ...(storeCode
      ? {
          code: 'DocumentStoreError',
          message: 'Ricardian document store is unavailable',
          fields: { code: storeCode },
        }
      : {}),
  });
}

function sendPublicFailure(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  storeCode?: string,
): void {
  const correlationId = correlationIdFor(req);
  res.setHeader?.('x-correlation-id', correlationId);
  res.status(status).json({
    ...failure(code, message),
    ...(storeCode ? { code: storeCode } : {}),
    correlationId,
  });
}

export class RicardianController {
  constructor(private readonly tenantOptions: TenantResolutionOptions) {}

  async createHash(
    req: Request<Record<string, never>, Record<string, never>, RicardianRegistrationRequest>,
    res: Response,
  ): Promise<void> {
    try {
      const payload = parseCreateHashBody(req.body);
      const tenantId = resolveTenant(req, payload.tenantId, this.tenantOptions);
      const hashed = buildRicardianHash(payload);
      try {
        const row = await createDocument({
          requestId: hashed.requestId,
          tenantId,
          documentRef: hashed.documentRef,
          hash: hashed.hash,
          rulesVersion: hashed.rulesVersion,
          canonicalJson: hashed.canonicalJson,
          metadata: hashed.metadata,
        });

        res.status(200).json(success(mapRowToResponse(row, tenantId)));
      } catch (error: unknown) {
        if (error instanceof DocumentConflictError) {
          sendPublicFailure(
            req,
            res,
            409,
            'Conflict',
            'Ricardian registration conflicts with immutable history',
            error.code,
          );
          return;
        }

        sendStoreFailure(req, res, error, 'createHash');
      }
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        sendPublicFailure(req, res, error.statusCode, error.code, error.message);
        return;
      }

      if (error instanceof CallerSafeError) {
        sendPublicFailure(req, res, 400, 'ValidationError', error.message);
        return;
      }

      sendStoreFailure(req, res, error, 'createHash');
    }
  }

  /** Generic lookup: minimal public attestation only, never terms or metadata. */
  async getHash(req: Request<{ hash: string }>, res: Response): Promise<void> {
    await this.respondWithRow(req, res, 'getHash', async () =>
      mapRowToAttestation(await getDocument(parseHashParam(req.params.hash))),
    );
  }

  /** Complete canonical terms and metadata, only for the tenant that registered them. */
  async getTenantDocument(req: Request<{ hash: string }>, res: Response): Promise<void> {
    await this.respondWithRow(req, res, 'getTenantDocument', async () => {
      const hash = parseHashParam(req.params.hash);
      const tenantId = resolveTenant(req, req.query.tenantId, this.tenantOptions);
      return mapRowToResponse(await getTenantDocument(hash, tenantId), tenantId);
    });
  }

  private async respondWithRow(
    req: Request<{ hash: string }>,
    res: Response,
    operation: string,
    load: () => Promise<RicardianHashAttestation | RicardianHashResponse>,
  ): Promise<void> {
    try {
      res.status(200).json(success(await load()));
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        sendPublicFailure(req, res, error.statusCode, error.code, error.message);
        return;
      }

      if (error instanceof DocumentNotFoundError) {
        sendPublicFailure(req, res, 404, 'NotFound', 'Ricardian hash not found', error.code);
        return;
      }

      sendStoreFailure(req, res, error, operation);
    }
  }
}

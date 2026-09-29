import { Request, Response } from 'express';
import { failure, HttpError, requireObject, requireString, success } from '@agroasys/shared-http';
import { createDocument, getDocument, getTenantDocument } from '../database/documentStore';
import { DocumentConflictError, DocumentNotFoundError, DocumentStoreError } from '../errors';
import {
  RicardianHashAttestation,
  RicardianHashResponse,
  RicardianHashRow,
  RicardianRegistrationRequest,
  TENANT_ID_PATTERN,
} from '../types';
import { buildRicardianHash } from '../utils/hash';

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

function parseTenantId(value: unknown): string {
  const tenantId = requireString(value, 'tenantId');
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new HttpError(400, 'ValidationError', 'Invalid tenantId format');
  }

  return tenantId;
}

function parseCreateHashBody(body: unknown): RicardianRegistrationRequest {
  const payload = requireObject(body, 'body') as unknown as RicardianRegistrationRequest;

  return {
    requestId:
      payload.requestId === undefined ? undefined : requireString(payload.requestId, 'requestId'),
    tenantId: parseTenantId(payload.tenantId),
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

export class RicardianController {
  async createHash(
    req: Request<Record<string, never>, Record<string, never>, RicardianRegistrationRequest>,
    res: Response,
  ): Promise<void> {
    try {
      const payload = parseCreateHashBody(req.body);
      const hashed = buildRicardianHash(payload);
      try {
        const row = await createDocument({
          requestId: hashed.requestId,
          tenantId: payload.tenantId,
          documentRef: hashed.documentRef,
          hash: hashed.hash,
          rulesVersion: hashed.rulesVersion,
          canonicalJson: hashed.canonicalJson,
          metadata: hashed.metadata,
        });

        res.status(200).json(success(mapRowToResponse(row, payload.tenantId)));
      } catch (error: unknown) {
        if (error instanceof DocumentConflictError) {
          res.status(409).json({
            ...failure('Conflict', error.message),
            code: error.code,
          });
          return;
        }

        if (error instanceof DocumentStoreError) {
          res.status(500).json({
            ...failure('DocumentStoreError', error.message),
            code: error.code,
          });
          return;
        }

        res
          .status(500)
          .json(
            failure(
              'InternalError',
              error instanceof Error ? error.message : 'Failed to persist Ricardian hash',
            ),
          );
      }
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json(failure(error.code, error.message, error.details));
        return;
      }

      res
        .status(400)
        .json(
          failure(
            'ValidationError',
            error instanceof Error ? error.message : 'Invalid Ricardian payload',
          ),
        );
    }
  }

  /** Generic lookup: minimal public attestation only, never terms or metadata. */
  async getHash(req: Request<{ hash: string }>, res: Response): Promise<void> {
    await this.respondWithRow(res, 'Failed to fetch Ricardian hash', async () =>
      mapRowToAttestation(await getDocument(parseHashParam(req.params.hash))),
    );
  }

  /** Complete canonical terms and metadata, only for the tenant that registered them. */
  async getTenantDocument(req: Request<{ hash: string }>, res: Response): Promise<void> {
    await this.respondWithRow(res, 'Failed to fetch Ricardian document', async () => {
      const hash = parseHashParam(req.params.hash);
      const tenantId = parseTenantId(req.query.tenantId);
      return mapRowToResponse(await getTenantDocument(hash, tenantId), tenantId);
    });
  }

  private async respondWithRow(
    res: Response,
    fallbackMessage: string,
    load: () => Promise<RicardianHashAttestation | RicardianHashResponse>,
  ): Promise<void> {
    try {
      res.status(200).json(success(await load()));
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json(failure(error.code, error.message, error.details));
        return;
      }

      if (error instanceof DocumentNotFoundError) {
        res.status(404).json({
          ...failure('NotFound', error.message),
          code: error.code,
        });
        return;
      }

      if (error instanceof DocumentStoreError) {
        res.status(500).json({
          ...failure('DocumentStoreError', error.message),
          code: error.code,
        });
        return;
      }

      res
        .status(500)
        .json(failure('InternalError', error instanceof Error ? error.message : fallbackMessage));
    }
  }
}

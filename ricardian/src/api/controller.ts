import { Request, Response } from 'express';
import { failure, HttpError, requireObject, requireString, success } from '@agroasys/shared-http';
import { createDocument, getDocument } from '../database/documentStore';
import { DocumentNotFoundError, DocumentStoreError } from '../errors';
import { RicardianHashRequest, RicardianHashResponse, RicardianHashRow } from '../types';
import { buildRicardianHash } from '../utils/hash';

function mapRowToResponse(row: RicardianHashRow): RicardianHashResponse {
  return {
    id: row.id,
    requestId: row.request_id,
    documentRef: row.document_ref,
    hash: row.hash,
    rulesVersion: row.rules_version,
    canonicalJson: row.canonical_json,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function parseCreateHashBody(body: unknown): RicardianHashRequest {
  const payload = requireObject(body, 'body') as unknown as RicardianHashRequest;

  return {
    requestId: payload.requestId === undefined ? undefined : requireString(payload.requestId, 'requestId'),
    documentRef: requireString(payload.documentRef, 'documentRef'),
    terms: requireObject(payload.terms, 'terms'),
    metadata:
      payload.metadata === undefined
        ? undefined
        : requireObject(payload.metadata, 'metadata'),
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
  async createHash(req: Request<{}, {}, RicardianHashRequest>, res: Response): Promise<void> {
    try {
      const payload = parseCreateHashBody(req.body);
      const hashed = buildRicardianHash(payload);
      try {
        const row = await createDocument({
          requestId: hashed.requestId,
          documentRef: hashed.documentRef,
          hash: hashed.hash,
          rulesVersion: hashed.rulesVersion,
          canonicalJson: hashed.canonicalJson,
          metadata: hashed.metadata,
        });

        res.status(200).json(success(mapRowToResponse(row)));
      } catch (error: unknown) {
        if (error instanceof DocumentStoreError) {
          res.status(500).json({
            ...failure('DocumentStoreError', error.message),
            code: error.code,
          });
          return;
        }

        res.status(500).json(
          failure('InternalError', error instanceof Error ? error.message : 'Failed to persist Ricardian hash'),
        );
      }
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json(failure(error.code, error.message, error.details));
        return;
      }

      res.status(400).json(failure('ValidationError', error instanceof Error ? error.message : 'Invalid Ricardian payload'));
    }
  }

  async getHash(req: Request<{ hash: string }>, res: Response): Promise<void> {
    try {
      const hash = parseHashParam(req.params.hash);
      const row = await getDocument(hash);

      res.status(200).json(success(mapRowToResponse(row)));
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

      res.status(500).json(failure('InternalError', error instanceof Error ? error.message : 'Failed to fetch Ricardian hash'));
    }
  }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import type { DownstreamServiceOrchestrator } from './serviceOrchestrator';

export interface RicardianDocumentRecord {
  id: string;
  requestId: string;
  documentRef: string;
  hash: string;
  rulesVersion: string;
  canonicalJson: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface RicardianHashResponse {
  success?: boolean;
  data?: RicardianDocumentRecord;
  error?: string;
  code?: string;
}

async function parseOptionalJson(response: Response): Promise<RicardianHashResponse | null> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as RicardianHashResponse;
  } catch {
    return null;
  }
}

function isDocumentRecord(value: unknown): value is RicardianDocumentRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as RicardianDocumentRecord).hash === 'string' &&
    typeof (value as RicardianDocumentRecord).documentRef === 'string' &&
    typeof (value as RicardianDocumentRecord).requestId === 'string' &&
    typeof (value as RicardianDocumentRecord).createdAt === 'string',
  );
}

export class RicardianClient {
  private readonly orchestrator?: DownstreamServiceOrchestrator;
  private readonly baseUrl?: string;
  private readonly requestTimeoutMs?: number;

  constructor(
    orchestratorOrBaseUrl: DownstreamServiceOrchestrator | string | undefined,
    requestTimeoutMs?: number,
  ) {
    if (typeof orchestratorOrBaseUrl === 'string' || orchestratorOrBaseUrl === undefined) {
      this.baseUrl = orchestratorOrBaseUrl;
      this.requestTimeoutMs = requestTimeoutMs;
      return;
    }

    this.orchestrator = orchestratorOrBaseUrl;
  }

  async getDocument(hash: string): Promise<RicardianDocumentRecord> {
    try {
      const response = this.orchestrator
        ? await this.orchestrator.fetch('ricardian', {
            method: 'GET',
            path: `/api/ricardian/v1/hash/${encodeURIComponent(hash)}`,
            readOnly: true,
            authenticated: true,
            operation: 'ricardian:getDocument',
          })
        : await this.fetchLegacy(hash);
      const payload = await parseOptionalJson(response);

      if (response.status === 404) {
        throw new GatewayError(404, 'NOT_FOUND', 'Ricardian document not found', {
          hash,
          upstream: 'ricardian',
        });
      }

      if (!response.ok) {
        throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Ricardian service request failed', {
          upstream: 'ricardian',
          status: response.status,
          reason: payload?.error ?? null,
          code: payload?.code ?? null,
        });
      }

      if (!payload?.success || !isDocumentRecord(payload.data)) {
        throw new GatewayError(
          502,
          'UPSTREAM_UNAVAILABLE',
          'Ricardian service returned an invalid payload',
          {
            upstream: 'ricardian',
          },
        );
      }

      return payload.data;
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }

      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Ricardian service request failed', {
        upstream: 'ricardian',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchLegacy(hash: string): Promise<Response> {
    if (!this.baseUrl) {
      throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Ricardian service is not configured', {
        upstream: 'ricardian',
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs ?? 5_000);

    try {
      return await fetch(`${this.baseUrl}/hash/${encodeURIComponent(hash)}`, {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayError(504, 'UPSTREAM_UNAVAILABLE', 'Ricardian service request timed out', {
          upstream: 'ricardian',
          timeoutMs: this.requestTimeoutMs ?? 5_000,
        });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServiceAuthHeaders } from './serviceAuth';
import {
  GaslessCreateTradeExecutionRequest,
  GaslessExecutionResponseEnvelope,
  GaslessExecutionSubmitOptions,
  GaslessUserActionExecutionRequest,
} from '../types/trade';
import { getErrorMessage, ValidationError } from '../types/errors';
import { GaslessSettlementRequestBuilder } from './gaslessExecutionPayload';
export {
  createGaslessExecutionPayloadHash,
  GaslessSettlementRequestBuilder,
  sponsoredActionToGaslessAction,
} from './gaslessExecutionPayload';
export type {
  GaslessCreateTradeExecutionInput,
  GaslessSettlementRuntimeConfig,
  GaslessUserActionExecutionInput,
} from './gaslessExecutionPayload';

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }

  return trimmed;
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function mergeHeaders(...headers: Array<HeadersInit | undefined>): Headers {
  const result = new Headers();

  for (const headerSet of headers) {
    if (!headerSet) {
      continue;
    }

    new Headers(headerSet).forEach((value, key) => {
      result.set(key, value);
    });
  }

  return result;
}

async function readJsonEnvelope(response: Response): Promise<GaslessExecutionResponseEnvelope> {
  try {
    return (await response.json()) as GaslessExecutionResponseEnvelope;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    throw new Error(`Gasless execution response was not JSON: ${message}`);
  }
}

export class GaslessSettlementClient extends GaslessSettlementRequestBuilder {
  async submitCreateTradeExecution<T = unknown>(
    request: GaslessCreateTradeExecutionRequest,
    options: GaslessExecutionSubmitOptions,
  ): Promise<T> {
    return this.submit('/settlement/gasless-executions/create-trade', request, options);
  }

  async submitUserActionExecution<T = unknown>(
    request: GaslessUserActionExecutionRequest,
    options: GaslessExecutionSubmitOptions,
  ): Promise<T> {
    return this.submit('/settlement/gasless-executions/user-action', request, options);
  }

  private async submit<T>(
    path: string,
    request: GaslessCreateTradeExecutionRequest | GaslessUserActionExecutionRequest,
    options: GaslessExecutionSubmitOptions,
  ): Promise<T> {
    const body = JSON.stringify(request);
    const endpointUrl = `${trimBaseUrl(options.baseUrl)}${path}`;
    const signingPath = new URL(endpointUrl).pathname;
    const idempotencyKey = requireNonEmpty(options.idempotencyKey, 'idempotencyKey');
    const serviceAuthHeaders: HeadersInit | undefined = options.serviceAuth
      ? {
          ...createServiceAuthHeaders({
            apiKey: options.serviceAuth.apiKey,
            apiSecret: options.serviceAuth.apiSecret,
            method: 'POST',
            path: signingPath,
            body,
            timestamp: options.serviceAuth.timestamp,
            nonce: options.serviceAuth.nonce,
          }),
        }
      : undefined;
    const headers = mergeHeaders(
      { 'Content-Type': 'application/json' },
      options.headers,
      serviceAuthHeaders,
      { 'Idempotency-Key': idempotencyKey },
    );
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(endpointUrl, {
      method: 'POST',
      headers,
      body,
    });
    const envelope = await readJsonEnvelope(response);

    if (!response.ok || !envelope.success) {
      throw new Error(
        envelope.message ||
          envelope.error ||
          `Gasless execution request failed (${response.status})`,
      );
    }

    return envelope.data as T;
  }
}

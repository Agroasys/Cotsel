/** SPDX-License-Identifier: Apache-2.0 */
import { createServiceAuthHeaders } from '../serviceAuth';
import { fingerprint } from './validation';
import { validateUserActionRetirementEvidence } from './retirement';
import type { VerifyUserActionRetirement, UserActionRetirementEvidence } from './retirement';
export const USER_ACTION_RETIREMENT_PATH =
  '/api/v1/settlement-handoffs/cotsel/lifecycle-action-retirement-evidence';
export interface UserActionRetirementTransportConfig {
  url: string;
  owningServiceId: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs: number;
}
/** Explicit HTTPS owning-domain read; no inferred URL, raw error/body logging, or retry. */
export function createUserActionRetirementTransport(
  config: UserActionRetirementTransportConfig,
): VerifyUserActionRetirement {
  const url = new URL(config.url);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== USER_ACTION_RETIREMENT_PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !config.owningServiceId ||
    !config.apiKey ||
    !config.apiSecret ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 9000
  )
    throw new Error('Invalid owning retirement evidence transport configuration');
  return async (scope) => {
    if (scope.ownerServiceId !== config.owningServiceId) return { status: 'unavailable' };
    try {
      const body = JSON.stringify({ scope }),
        expected = fingerprint(scope);
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...createServiceAuthHeaders({
            apiKey: config.apiKey,
            apiSecret: config.apiSecret,
            method: 'POST',
            path: url.pathname,
            query: '',
            body,
          }),
        },
        body,
      });
      if (!response.ok) return { status: 'unavailable' };
      const reader = response.body?.getReader();
      if (!reader) return { status: 'unavailable' };
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const value = await reader.read();
          if (value.done) break;
          bytes += value.value.byteLength;
          if (bytes > 262144) return { status: 'unavailable' };
          chunks.push(value.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || !('data' in payload))
        return { status: 'unavailable' };
      const data = payload.data;
      if (!data || typeof data !== 'object' || !('status' in data))
        return { status: 'unavailable' };
      if (
        (data.status === 'unavailable' || data.status === 'contradicted') &&
        Object.keys(data).length === 1
      )
        return { status: data.status };
      if (
        data.status !== 'verified' ||
        Object.keys(data).some((key) => !['status', 'evidence'].includes(key)) ||
        !('evidence' in data) ||
        !data.evidence ||
        typeof data.evidence !== 'object' ||
        !('scope' in data.evidence) ||
        fingerprint(data.evidence.scope) !== expected
      )
        return { status: 'unavailable' };
      validateUserActionRetirementEvidence(data.evidence as UserActionRetirementEvidence, scope);
      // Canonical evidence is rechecked by verifyNonceOwnership before locked progression.
      return data as Awaited<ReturnType<VerifyUserActionRetirement>>;
    } catch {
      return { status: 'unavailable' };
    }
  };
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type AnyExecutionAdapter,
  type ExecutionAdapter,
  type ExecutionCapability,
  type ExecutionObservation,
  type ExecutionPayloads,
  guardExecutionAdapter,
  isExecutionCapability,
} from './adapters';
import {
  assertCustodyPermits,
  assertSettlementModeWithinDeployment,
  CustodyFirewallError,
  type CustodyMode,
} from './custody';
import {
  type ExecutionConfigProblem,
  type ExecutionCustodyDeclaration,
  validateExecutionConfig,
} from './config';
import {
  createInMemoryExecutionIdempotencyStore,
  type ExecutionIdempotencyRecord,
  type StoredExecutionResult,
} from './idempotency';
import {
  type CreateExecutionRouterOptions,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  type ExecutionAlert,
  ExecutionConfigError,
  ExecutionIdempotencyConflictError,
  type ExecutionRouter,
  ExecutionRoutingError,
  type RoutedExecutionRequest,
  type RoutedExecutionResult,
} from './routerTypes';
import {
  canonicalExecutionHash,
  executionPayloadProblems,
  expectedExecutionObservation,
  verifyExecutionObservation,
} from './verification';

const OUTCOMES = new Set(['pending', 'succeeded', 'failed', 'unknown']);
const TIMED_OUT = Symbol('timedOut');

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
}

/**
 * Builds the execution router. It never throws on bad configuration: it reports
 * the problems through `readiness()` and refuses every call until they are fixed,
 * so a service can expose the failure on its readiness endpoint.
 */
export function createExecutionRouter(options: CreateExecutionRouterOptions): ExecutionRouter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  const validation = validateExecutionConfig(options.config, options.adapters, {
    requiredCapabilities: options.requiredCapabilities,
  });
  const problems: ExecutionConfigProblem[] = validation.ok ? [] : [...validation.problems];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    problems.push({ code: 'timeout_invalid' });
  }
  const declaration = validation.ok && problems.length === 0 ? validation.declaration : null;
  const store = options.idempotencyStore ?? createInMemoryExecutionIdempotencyStore();
  const adapters = new Map<string, AnyExecutionAdapter>();
  if (declaration) {
    for (const adapter of options.adapters) {
      adapters.set(
        adapter.descriptor.id,
        guardExecutionAdapter(adapter as ExecutionAdapter) as AnyExecutionAdapter,
      );
    }
  }
  const inFlight = new Map<
    string,
    { fingerprint: string; result: Promise<RoutedExecutionResult> }
  >();

  const alert = (value: ExecutionAlert): void => {
    try {
      options.onAlert?.(value);
    } catch {
      // Alerting must never change a routing decision.
    }
  };

  function ready(): ExecutionCustodyDeclaration {
    if (!declaration) {
      throw new ExecutionConfigError(problems);
    }
    return declaration;
  }

  function firewall(
    capability: ExecutionCapability,
    adapter: AnyExecutionAdapter,
    settlementMode: unknown,
    deploymentMode: CustodyMode,
    idempotencyKey: string,
  ): asserts settlementMode is CustodyMode {
    try {
      assertSettlementModeWithinDeployment(settlementMode, deploymentMode);
      assertCustodyPermits(settlementMode, adapter.descriptor, 'router');
    } catch (error) {
      if (error instanceof CustodyFirewallError) {
        alert({
          code: 'custody_firewall_rejected',
          capability,
          adapterId: adapter.descriptor.id,
          idempotencyKey,
          detail: error.rejection,
        });
      }
      throw error;
    }
  }

  function resolve<C extends ExecutionCapability>(
    capability: C,
    request: { idempotencyKey: unknown; settlementCustodyMode: unknown },
  ): { declaration: ExecutionCustodyDeclaration; adapter: ExecutionAdapter<C> } {
    const current = ready();
    if (!isExecutionCapability(capability)) {
      throw new ExecutionRoutingError('capability_unknown');
    }
    if (!validIdempotencyKey(request?.idempotencyKey)) {
      throw new ExecutionRoutingError('idempotency_key_invalid');
    }
    const route = current.routes[capability];
    const adapter = route ? adapters.get(route.adapterId) : undefined;
    if (!adapter) {
      throw new ExecutionRoutingError('capability_not_configured', { capability });
    }
    firewall(
      capability,
      adapter,
      request.settlementCustodyMode,
      current.custodyMode,
      request.idempotencyKey,
    );
    return { declaration: current, adapter: adapter as unknown as ExecutionAdapter<C> };
  }

  function checkPayload<C extends ExecutionCapability>(
    capability: C,
    payload: ExecutionPayloads[C],
  ): void {
    const payloadProblems = executionPayloadProblems(capability, payload);
    if (payloadProblems.length > 0) {
      throw new ExecutionRoutingError('payload_invalid', { problems: payloadProblems });
    }
  }

  function routed(
    record: ExecutionIdempotencyRecord,
    idempotencyKey: string,
    result: StoredExecutionResult | { outcome: 'not_found'; operationRef: string | null },
    replayed: boolean,
  ): RoutedExecutionResult {
    const observation = 'observation' in result ? result.observation : undefined;
    return {
      outcome: result.outcome,
      operationRef: result.operationRef,
      ...('reason' in result && result.reason ? { reason: result.reason } : {}),
      ...(observation ? { observation: structuredClone(observation) } : {}),
      capability: record.capability,
      adapterId: record.adapterId,
      custodyMode: record.custodyMode,
      configHash: record.configHash,
      idempotencyKey,
      settlementId: record.settlementId,
      replayed,
    };
  }

  /**
   * Turns whatever the adapter returned into a result Cotsel may act on. Anything
   * malformed, late or contradicting the request becomes `unknown`.
   */
  function settle(
    record: ExecutionIdempotencyRecord,
    idempotencyKey: string,
    returned: unknown,
    allowNotFound: boolean,
  ): {
    result: StoredExecutionResult | { outcome: 'not_found'; operationRef: null };
  } {
    if (returned === TIMED_OUT) {
      return { result: { outcome: 'unknown', operationRef: null, reason: 'timeout' } };
    }
    try {
      returned = structuredClone(returned);
    } catch {
      return { result: { outcome: 'unknown', operationRef: null, reason: 'result_invalid' } };
    }
    const value = returned as {
      outcome?: unknown;
      operationRef?: unknown;
      observation?: ExecutionObservation;
      reason?: unknown;
    } | null;
    const outcome = value?.outcome;
    if (allowNotFound && outcome === 'not_found') {
      return { result: { outcome: 'not_found', operationRef: null } };
    }
    const operationRef = typeof value?.operationRef === 'string' ? value.operationRef : null;
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      return { result: { outcome: 'unknown', operationRef, reason: 'result_invalid' } };
    }
    if (outcome === 'succeeded' && operationRef === null) {
      return { result: { outcome: 'unknown', operationRef, reason: 'operation_ref_missing' } };
    }
    const mismatch = verifyExecutionObservation(record.expected, outcome, value?.observation);
    if (mismatch) {
      alert({
        code: 'observation_mismatch',
        capability: record.capability,
        adapterId: record.adapterId,
        idempotencyKey,
        settlementId: record.settlementId,
        detail: mismatch,
      });
      return {
        result: { outcome: 'unknown', operationRef, reason: `observation_mismatch:${mismatch}` },
      };
    }
    const reason = typeof value?.reason === 'string' ? value.reason : undefined;
    return {
      result: {
        outcome: outcome as StoredExecutionResult['outcome'],
        operationRef,
        ...(reason ? { reason } : {}),
        ...(value?.observation ? { observation: value.observation } : {}),
      },
    };
  }

  function reportUnknown(record: ExecutionIdempotencyRecord, key: string, reason?: string): void {
    alert({
      code: 'outcome_unknown',
      capability: record.capability,
      adapterId: record.adapterId,
      idempotencyKey: key,
      settlementId: record.settlementId,
      detail: reason ?? 'unknown',
    });
  }

  async function submitOnce<C extends ExecutionCapability>(
    capability: C,
    request: RoutedExecutionRequest<C>,
    adapter: ExecutionAdapter<C>,
    record: ExecutionIdempotencyRecord,
  ): Promise<RoutedExecutionResult> {
    const existing = await store.claim(record);
    if (existing) {
      if (existing.fingerprint !== record.fingerprint) {
        alert({
          code: 'idempotency_conflict',
          capability,
          adapterId: existing.adapterId,
          idempotencyKey: request.idempotencyKey,
          detail: 'fingerprint_mismatch',
        });
        throw new ExecutionIdempotencyConflictError(record.key);
      }
      // A claim without a result means another submit is running or died after
      // reaching the provider. Never call the provider again; resolve via status.
      const stored = existing.result ?? {
        outcome: 'unknown' as const,
        operationRef: null,
        reason: 'submission_in_flight',
      };
      return routed(existing, request.idempotencyKey, stored, true);
    }

    let returned: unknown;
    try {
      returned = await withTimeout(
        () =>
          adapter.submit(
            {
              idempotencyKey: request.idempotencyKey,
              custodyMode: request.settlementCustodyMode,
              settlementId: request.settlementId,
            },
            request.payload,
          ),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof CustodyFirewallError) {
        // Rejected at the adapter entry, before any provider call.
        await store.release(record.key);
        alert({
          code: 'custody_firewall_rejected',
          capability,
          adapterId: record.adapterId,
          idempotencyKey: request.idempotencyKey,
          detail: error.rejection,
        });
        throw error;
      }
      returned = { outcome: 'unknown', operationRef: null, reason: 'adapter_error' };
    }
    const { result } = settle(record, request.idempotencyKey, returned, false);
    const stored = result as StoredExecutionResult;
    await store.record(record.key, stored);
    if (stored.outcome === 'unknown') {
      reportUnknown(record, request.idempotencyKey, stored.reason);
    }
    return routed(record, request.idempotencyKey, stored, false);
  }

  return {
    readiness() {
      return {
        ready: declaration !== null,
        custodyMode: declaration?.custodyMode ?? null,
        configHash: declaration?.configHash ?? null,
        problems: problems.map((problem) => ({ ...problem })),
      };
    },

    declaration() {
      return structuredClone(ready());
    },

    async preflight(capability, request) {
      const { adapter } = resolve(capability, request);
      checkPayload(capability, request.payload);
      try {
        const returned = await withTimeout(
          () =>
            adapter.preflight(
              {
                idempotencyKey: request.idempotencyKey,
                custodyMode: request.settlementCustodyMode,
                settlementId: request.settlementId,
              },
              request.payload,
            ),
          timeoutMs,
        );
        if (returned === TIMED_OUT) {
          return { ok: false, problems: ['timeout'] };
        }
        if (typeof returned?.ok !== 'boolean' || !Array.isArray(returned.problems)) {
          return { ok: false, problems: ['result_invalid'] };
        }
        return {
          ok: returned.ok && returned.problems.length === 0,
          problems: [...returned.problems],
        };
      } catch (error) {
        if (error instanceof CustodyFirewallError) {
          throw error;
        }
        return { ok: false, problems: ['adapter_error'] };
      }
    },

    async submit(capability, request) {
      try {
        request = structuredClone(request);
      } catch {
        throw new ExecutionRoutingError('payload_invalid', { problems: ['request_not_cloneable'] });
      }
      const { declaration: current, adapter } = resolve(capability, request);
      checkPayload(capability, request.payload);
      const settlementId = request.settlementId ?? null;
      const record: ExecutionIdempotencyRecord = {
        key: `${capability}:${request.idempotencyKey}`,
        capability,
        fingerprint: canonicalExecutionHash({
          capability,
          settlementId,
          custodyMode: request.settlementCustodyMode,
          payload: request.payload,
        }),
        adapterId: adapter.descriptor.id,
        settlementId,
        custodyMode: request.settlementCustodyMode,
        configHash: current.configHash,
        expected: expectedExecutionObservation(capability, request.payload),
        state: 'in_flight',
        result: null,
      };

      const running = inFlight.get(record.key);
      if (running) {
        if (running.fingerprint !== record.fingerprint) {
          throw new ExecutionIdempotencyConflictError(record.key);
        }
        return { ...structuredClone(await running.result), replayed: true };
      }
      const result = submitOnce(capability, { ...request, settlementId }, adapter, record);
      inFlight.set(record.key, { fingerprint: record.fingerprint, result });
      try {
        return await result;
      } finally {
        inFlight.delete(record.key);
      }
    },

    async status(capability, query) {
      const current = ready();
      if (!isExecutionCapability(capability)) {
        throw new ExecutionRoutingError('capability_unknown');
      }
      if (!validIdempotencyKey(query?.idempotencyKey)) {
        throw new ExecutionRoutingError('idempotency_key_invalid');
      }
      const key = `${capability}:${query.idempotencyKey}`;
      const record = await store.get(key);
      if (!record) {
        throw new ExecutionRoutingError('no_submission_record', { key });
      }
      // Status goes to the adapter that took the submit, even if routing changed since.
      const adapter = adapters.get(record.adapterId);
      if (!adapter) {
        throw new ExecutionRoutingError('submitting_adapter_unavailable', {
          adapterId: record.adapterId,
        });
      }
      if (query.settlementCustodyMode !== record.custodyMode) {
        throw new ExecutionRoutingError('custody_mode_changed', { key });
      }
      firewall(
        capability,
        adapter,
        query.settlementCustodyMode,
        current.custodyMode,
        query.idempotencyKey,
      );

      let returned: unknown;
      try {
        returned = await withTimeout(
          () =>
            adapter.status({
              idempotencyKey: query.idempotencyKey,
              custodyMode: query.settlementCustodyMode,
              operationRef: record.result?.operationRef ?? null,
            }),
          timeoutMs,
        );
      } catch (error) {
        if (error instanceof CustodyFirewallError) {
          throw error;
        }
        reportUnknown(record, query.idempotencyKey, 'adapter_error');
        return routed(
          record,
          query.idempotencyKey,
          {
            outcome: 'unknown',
            operationRef: record.result?.operationRef ?? null,
            reason: 'adapter_error',
          },
          false,
        );
      }
      const { result } = settle(record, query.idempotencyKey, returned, true);
      if (result.outcome === 'unknown') {
        reportUnknown(record, query.idempotencyKey, result.reason);
      } else if (result.outcome !== 'not_found') {
        // Only a verified provider answer replaces what is stored.
        await store.record(key, result);
      }
      return routed(record, query.idempotencyKey, result, false);
    },
  };
}

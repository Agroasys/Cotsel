/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type ExecutionAdapter,
  type ExecutionCapability,
  type ExecutionContext,
  type ExecutionPayloads,
  executionDescriptorProblems,
} from './adapters';
import {
  CUSTODY_MODES,
  CustodyFirewallError,
  type CustodyMode,
  custodyModePermits,
} from './custody';
import {
  executionPayloadProblems,
  expectedExecutionObservation,
  verifyExecutionObservation,
} from './verification';

/**
 * What an adapter's own test suite supplies to run the conformance checks. The
 * adapter must be backed by a sandbox or fake provider, never a live one.
 */
export interface ExecutionAdapterConformanceFixture<C extends ExecutionCapability> {
  adapter: ExecutionAdapter<C>;
  /** A fresh, valid payload the sandbox provider accepts. */
  validPayload(): ExecutionPayloads[C];
  /** Number of operations the sandbox provider has actually performed. */
  providerOperationCount(): number | Promise<number>;
  /** Prefix for idempotency keys, so repeated runs against one sandbox don't collide. */
  keyPrefix?: string;
}

export type ExecutionConformanceOperation =
  'descriptor' | 'preflight' | 'submit' | 'status' | 'custody_firewall';

export interface ExecutionConformanceCheck {
  id: string;
  operation: ExecutionConformanceOperation;
  /** The obligation this check proves, stated as the rule an adapter must follow. */
  requirement: string;
  run<C extends ExecutionCapability>(
    fixture: ExecutionAdapterConformanceFixture<C>,
    keys: () => string,
  ): Promise<void>;
}

export class ExecutionConformanceFailure extends Error {
  constructor(
    public readonly checkId: string,
    message: string,
  ) {
    super(`${checkId}: ${message}`);
    this.name = 'ExecutionConformanceFailure';
  }
}

function context(key: string, custodyMode: CustodyMode): ExecutionContext {
  return { idempotencyKey: key, custodyMode, settlementId: 'conformance-settlement' };
}

function check(condition: unknown, id: string, message: string): asserts condition {
  if (!condition) {
    throw new ExecutionConformanceFailure(id, message);
  }
}

/**
 * Every operation of the adapter interface and the rule each must satisfy. The
 * list is the documentation of the interface contract; see
 * `docs/architecture/execution-adapters.md`.
 */
export const EXECUTION_ADAPTER_CONFORMANCE_CHECKS: readonly ExecutionConformanceCheck[] = [
  {
    id: 'descriptor.valid',
    operation: 'descriptor',
    requirement:
      'The descriptor declares a stable id, one known capability, a known custody class and a version.',
    async run(fixture) {
      const problems = executionDescriptorProblems(fixture.adapter.descriptor);
      check(problems.length === 0, this.id, `descriptor problems: ${problems.join(', ')}`);
    },
  },
  {
    id: 'preflight.accepts_valid_request_without_side_effects',
    operation: 'preflight',
    requirement:
      'preflight returns { ok, problems } for a valid request and performs no provider operation.',
    async run(fixture, keys) {
      const { adapter } = fixture;
      const payload = fixture.validPayload();
      const payloadProblems = executionPayloadProblems(adapter.descriptor.capability, payload);
      check(payloadProblems.length === 0, this.id, `fixture payload invalid: ${payloadProblems}`);
      const before = await fixture.providerOperationCount();
      const result = await adapter.preflight(
        context(keys(), adapter.descriptor.custodyClass),
        payload,
      );
      check(result.ok === true && Array.isArray(result.problems), this.id, 'preflight not ok');
      check((await fixture.providerOperationCount()) === before, this.id, 'preflight had effects');
    },
  },
  {
    id: 'submit.reports_a_known_outcome',
    operation: 'submit',
    requirement:
      'submit returns pending, succeeded, failed or unknown; succeeded carries an operation reference and an observation matching the request.',
    async run(fixture, keys) {
      const { adapter } = fixture;
      const payload = fixture.validPayload();
      const result = await adapter.submit(
        context(keys(), adapter.descriptor.custodyClass),
        payload,
      );
      check(
        ['pending', 'succeeded', 'failed', 'unknown'].includes(result.outcome),
        this.id,
        `unexpected outcome ${String(result.outcome)}`,
      );
      if (result.outcome === 'succeeded') {
        check(typeof result.operationRef === 'string', this.id, 'success without operation ref');
      }
      const mismatch = verifyExecutionObservation(
        expectedExecutionObservation(adapter.descriptor.capability, payload),
        result.outcome,
        result.observation,
      );
      check(mismatch === null, this.id, `observation does not match request: ${mismatch}`);
    },
  },
  {
    id: 'submit.one_operation_per_idempotency_key',
    operation: 'submit',
    requirement:
      'Submitting the same request twice with one idempotency key performs one provider operation and returns the same operation reference.',
    async run(fixture, keys) {
      const { adapter } = fixture;
      const key = keys();
      const payload = fixture.validPayload();
      const mode = adapter.descriptor.custodyClass;
      const before = await fixture.providerOperationCount();
      const first = await adapter.submit(context(key, mode), payload);
      const second = await adapter.submit(context(key, mode), payload);
      const performed = (await fixture.providerOperationCount()) - before;
      check(performed <= 1, this.id, `${performed} provider operations for one key`);
      check(first.operationRef === second.operationRef, this.id, 'operation reference changed');
    },
  },
  {
    id: 'status.resolves_from_idempotency_key',
    operation: 'status',
    requirement:
      'After a submit, status with only the idempotency key returns that operation, so an unknown outcome can be recovered without the operation reference.',
    async run(fixture, keys) {
      const { adapter } = fixture;
      const key = keys();
      const mode = adapter.descriptor.custodyClass;
      const submitted = await adapter.submit(context(key, mode), fixture.validPayload());
      const status = await adapter.status({ idempotencyKey: key, custodyMode: mode });
      check(status.outcome !== 'not_found', this.id, 'submitted operation not found by key');
      if (submitted.operationRef !== null) {
        check(
          status.operationRef === submitted.operationRef,
          this.id,
          'status returned another op',
        );
      }
    },
  },
  {
    id: 'status.not_found_for_unused_key',
    operation: 'status',
    requirement:
      'status for a key that was never submitted returns not_found: it neither throws nor reports any other outcome.',
    async run(fixture, keys) {
      const { adapter } = fixture;
      const status = await adapter.status({
        idempotencyKey: keys(),
        custodyMode: adapter.descriptor.custodyClass,
      });
      check(status.outcome === 'not_found', this.id, `got ${String(status.outcome)}`);
    },
  },
  {
    id: 'custody_firewall.enforced_at_adapter_entry',
    operation: 'custody_firewall',
    requirement:
      'Every entry point rejects a custody mode that forbids the adapter, or an undeclared mode, with CustodyFirewallError and no provider operation; permitted modes are accepted.',
    async run(fixture, keys) {
      const { adapter } = fixture;
      const before = await fixture.providerOperationCount();
      const modes: unknown[] = [...CUSTODY_MODES, 'undeclared_mode'];
      for (const mode of modes) {
        const permitted =
          typeof mode === 'string' &&
          (CUSTODY_MODES as readonly string[]).includes(mode) &&
          custodyModePermits(mode as CustodyMode, adapter.descriptor.custodyClass);
        const calls: Array<() => Promise<unknown>> = [
          () => adapter.preflight(context(keys(), mode as CustodyMode), fixture.validPayload()),
          () => adapter.status({ idempotencyKey: keys(), custodyMode: mode as CustodyMode }),
        ];
        if (!permitted) {
          calls.push(() =>
            adapter.submit(context(keys(), mode as CustodyMode), fixture.validPayload()),
          );
        }
        for (const call of calls) {
          let rejected: unknown = null;
          try {
            await call();
          } catch (error) {
            rejected = error;
          }
          if (permitted) {
            check(rejected === null, this.id, `permitted mode ${String(mode)} was rejected`);
          } else {
            check(
              rejected instanceof CustodyFirewallError,
              this.id,
              `mode ${String(mode)} reached a ${adapter.descriptor.custodyClass} adapter`,
            );
          }
        }
      }
      check(
        (await fixture.providerOperationCount()) === before,
        this.id,
        'a rejected call reached the provider',
      );
    },
  },
];

export interface ExecutionConformanceResult {
  id: string;
  operation: ExecutionConformanceOperation;
  passed: boolean;
  failure?: string;
}

export interface ExecutionConformanceReport {
  adapterId: string;
  capability: string;
  passed: boolean;
  results: ExecutionConformanceResult[];
}

/** Runs every check against one adapter and reports each result; never throws. */
export async function runExecutionAdapterConformance<C extends ExecutionCapability>(
  fixture: ExecutionAdapterConformanceFixture<C>,
): Promise<ExecutionConformanceReport> {
  let counter = 0;
  const prefix = fixture.keyPrefix ?? `conformance-${Date.now().toString(36)}`;
  const keys = (): string => `${prefix}-${(counter += 1)}`;
  const results: ExecutionConformanceResult[] = [];
  for (const conformanceCheck of EXECUTION_ADAPTER_CONFORMANCE_CHECKS) {
    try {
      await conformanceCheck.run(fixture, keys);
      results.push({
        id: conformanceCheck.id,
        operation: conformanceCheck.operation,
        passed: true,
      });
    } catch (error) {
      results.push({
        id: conformanceCheck.id,
        operation: conformanceCheck.operation,
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    adapterId: String(fixture.adapter.descriptor?.id),
    capability: String(fixture.adapter.descriptor?.capability),
    passed: results.every((result) => result.passed),
    results,
  };
}

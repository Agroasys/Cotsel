/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXECUTION_ADAPTER_CONFORMANCE_CHECKS,
  EXECUTION_CAPABILITIES,
  type ExecutionCapability,
  runExecutionAdapterConformance,
} from '../src/execution';
import {
  createFakeProvider,
  type FakeProviderOptions,
  signedTransaction,
  validPayload,
} from './fixtures/fakeExecutionProvider';

let presigned = '';

beforeAll(async () => {
  presigned = await signedTransaction(11);
});

async function conformance(capability: ExecutionCapability, options: FakeProviderOptions = {}) {
  const provider = createFakeProvider(capability, options);
  return runExecutionAdapterConformance({
    adapter: provider.adapter,
    validPayload: () => validPayload(capability, presigned),
    providerOperationCount: () => provider.operations(),
    keyPrefix: `${capability}-${options.behaviour ?? 'honest'}`,
  });
}

function failed(report: Awaited<ReturnType<typeof conformance>>): string[] {
  return report.results.filter((result) => !result.passed).map((result) => result.id);
}

describe('execution adapter conformance suite', () => {
  test.each(
    EXECUTION_CAPABILITIES.flatMap((capability) =>
      (['non_custodial', 'composed_partner', 'licensed_custodial'] as const).map(
        (custodyClass) => [capability, custodyClass] as const,
      ),
    ),
  )('a correct %s adapter of class %s passes every check', async (capability, custodyClass) => {
    const report = await conformance(capability, { custodyClass });

    expect(failed(report)).toEqual([]);
    expect(report.results).toHaveLength(EXECUTION_ADAPTER_CONFORMANCE_CHECKS.length);
  });

  test('an adapter that repeats provider operations for one key fails', async () => {
    const report = await conformance('payout', { behaviour: 'not_idempotent' });
    expect(failed(report)).toContain('submit.one_operation_per_idempotency_key');
  });

  test('a custodial adapter without the entry-point firewall fails', async () => {
    const report = await conformance('payout', {
      custodyClass: 'licensed_custodial',
      unguarded: true,
    });
    expect(failed(report)).toEqual(['custody_firewall.enforced_at_adapter_entry']);
  });

  test('an adapter that reports success for a different amount fails', async () => {
    const report = await conformance('funding', { behaviour: 'misreport_amount' });
    expect(failed(report)).toContain('submit.reports_a_known_outcome');
  });

  test('an adapter that reports success without an observation fails', async () => {
    const report = await conformance('chain', { behaviour: 'success_without_observation' });
    expect(failed(report)).toContain('submit.reports_a_known_outcome');
  });

  test('every interface operation is covered and documented', () => {
    const operations = new Set(
      EXECUTION_ADAPTER_CONFORMANCE_CHECKS.map((check) => check.operation),
    );
    expect([...operations].sort()).toEqual(
      ['custody_firewall', 'descriptor', 'preflight', 'status', 'submit'].sort(),
    );

    const documentation = fs.readFileSync(
      path.resolve(__dirname, '../../docs/architecture/execution-adapters.md'),
      'utf8',
    );
    for (const check of EXECUTION_ADAPTER_CONFORMANCE_CHECKS) {
      expect(documentation).toContain(`\`${check.id}\``);
    }
  });
});

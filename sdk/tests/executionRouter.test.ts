/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type AnyExecutionAdapter,
  createExecutionRouter,
  CustodyFirewallError,
  exactAmount,
  type ExecutionAlert,
  ExecutionConfigError,
  ExecutionIdempotencyConflictError,
  ExecutionRoutingError,
  validateExecutionConfig,
} from '../src/execution';
import {
  createFakeProvider,
  ESCROW,
  type FakeBehaviour,
  signingIntent,
  USDC,
  validPayload,
} from './fixtures/fakeExecutionProvider';

const nonCustodialFunding = () => createFakeProvider('funding', { id: 'direct-usdc' });
const custodialPayout = () =>
  createFakeProvider('payout', { id: 'licensed-payout', custodyClass: 'licensed_custodial' });

function fundingRequest(idempotencyKey: string) {
  return {
    idempotencyKey,
    settlementId: 'settlement-1',
    settlementCustodyMode: 'non_custodial' as const,
    payload: validPayload('funding', ''),
  };
}

describe('execution configuration and readiness', () => {
  test('a valid declaration is ready and its hash ignores key order', () => {
    const funding = nonCustodialFunding();
    const signing = createFakeProvider('signing', { id: 'aws-kms-signer' });
    const adapters = [funding.adapter, signing.adapter] as AnyExecutionAdapter[];
    const first = createExecutionRouter({
      config: {
        custodyMode: 'non_custodial',
        adapters: { funding: 'direct-usdc', signing: 'aws-kms-signer' },
      },
      adapters,
    });
    const second = createExecutionRouter({
      config: {
        adapters: { signing: 'aws-kms-signer', funding: 'direct-usdc' },
        custodyMode: 'non_custodial',
      },
      adapters,
    });

    expect(first.readiness()).toEqual({
      ready: true,
      custodyMode: 'non_custodial',
      configHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      problems: [],
    });
    expect(second.readiness().configHash).toBe(first.readiness().configHash);
    expect(first.declaration().routes.signing).toEqual({
      adapterId: 'aws-kms-signer',
      adapterVersion: '1.0.0',
      custodyClass: 'non_custodial',
    });
  });

  test.each([
    ['custody mode missing', { adapters: {} }, 'custody_mode_missing'],
    ['custody mode unknown', { custodyMode: 'bank', adapters: {} }, 'custody_mode_unknown'],
    [
      'unknown top-level key',
      { custodyMode: 'non_custodial', adapters: {}, x: 1 },
      'config_unknown_key',
    ],
    [
      'adapters not an object',
      { custodyMode: 'non_custodial', adapters: [] },
      'adapters_not_object',
    ],
    [
      'unknown capability',
      { custodyMode: 'non_custodial', adapters: { lending: 'direct-usdc' } },
      'capability_unknown',
    ],
    [
      'unregistered adapter',
      { custodyMode: 'non_custodial', adapters: { funding: 'nope' } },
      'adapter_not_registered',
    ],
    [
      'adapter for another capability',
      { custodyMode: 'non_custodial', adapters: { payout: 'direct-usdc' } },
      'adapter_capability_mismatch',
    ],
    [
      'custodial adapter in a non-custodial deployment',
      { custodyMode: 'non_custodial', adapters: { payout: 'licensed-payout' } },
      'adapter_custody_forbidden',
    ],
    [
      'required capability not routed',
      { custodyMode: 'non_custodial', adapters: {} },
      'capability_required',
    ],
    ['not an object', 'non_custodial', 'config_not_object'],
  ])('readiness fails when %s', (_label, config, code) => {
    const router = createExecutionRouter({
      config,
      adapters: [nonCustodialFunding().adapter, custodialPayout().adapter] as AnyExecutionAdapter[],
      requiredCapabilities: ['funding'],
    });

    expect(router.readiness().ready).toBe(false);
    expect(router.readiness().problems.map((problem) => problem.code)).toContain(code);
    expect(() => router.declaration()).toThrow(ExecutionConfigError);
    return expect(router.submit('funding', fundingRequest('k-1'))).rejects.toThrow(
      ExecutionConfigError,
    );
  });

  test('readiness fails on duplicate adapter ids and on an invalid timeout', () => {
    const a = nonCustodialFunding().adapter;
    const b = nonCustodialFunding().adapter;
    const duplicate = validateExecutionConfig(
      { custodyMode: 'non_custodial', adapters: { funding: 'direct-usdc' } },
      [a, b] as AnyExecutionAdapter[],
    );
    expect(duplicate).toEqual({
      ok: false,
      problems: [{ code: 'registry_duplicate_id', subject: 'direct-usdc' }],
    });

    const router = createExecutionRouter({
      config: { custodyMode: 'non_custodial', adapters: { funding: 'direct-usdc' } },
      adapters: [a] as AnyExecutionAdapter[],
      timeoutMs: 0,
    });
    expect(router.readiness().problems).toEqual([{ code: 'timeout_invalid' }]);
  });
});

describe('custody firewall', () => {
  test('a non-custodial deployment cannot route to a custodial adapter', async () => {
    const payout = custodialPayout();
    const alerts: ExecutionAlert[] = [];

    // 1. Configuration naming the custodial adapter never becomes ready.
    const configured = createExecutionRouter({
      config: { custodyMode: 'non_custodial', adapters: { payout: 'licensed-payout' } },
      adapters: [payout.adapter] as AnyExecutionAdapter[],
    });
    expect(configured.readiness().ready).toBe(false);

    // 2. A settlement cannot claim more custody than the deployment allows.
    const funding = nonCustodialFunding();
    const deployment = createExecutionRouter({
      config: { custodyMode: 'non_custodial', adapters: { funding: 'direct-usdc' } },
      adapters: [funding.adapter] as AnyExecutionAdapter[],
      onAlert: (value) => alerts.push(value),
    });
    await expect(
      deployment.submit('funding', {
        ...fundingRequest('k-escalate'),
        settlementCustodyMode: 'licensed_custodial',
      }),
    ).rejects.toMatchObject({
      name: 'CustodyFirewallError',
      context: { rejection: 'settlement_mode_exceeds_deployment', enforcedAt: 'router' },
    });

    // 3. Calling the custodial adapter directly is rejected at its own entry point.
    await expect(
      payout.adapter.submit(
        { idempotencyKey: 'k-direct', custodyMode: 'non_custodial', settlementId: 's' },
        validPayload('payout', ''),
      ),
    ).rejects.toMatchObject({
      name: 'CustodyFirewallError',
      context: { rejection: 'adapter_class_forbidden', enforcedAt: 'adapter' },
    });

    expect(payout.operations()).toBe(0);
    expect(funding.operations()).toBe(0);
    expect(alerts).toEqual([
      expect.objectContaining({
        code: 'custody_firewall_rejected',
        detail: 'settlement_mode_exceeds_deployment',
      }),
    ]);
  });

  test('a non-custodial settlement in a custodial deployment cannot reach a custodial adapter', async () => {
    const payout = custodialPayout();
    const router = createExecutionRouter({
      config: { custodyMode: 'licensed_custodial', adapters: { payout: 'licensed-payout' } },
      adapters: [payout.adapter] as AnyExecutionAdapter[],
    });
    const request = {
      idempotencyKey: 'k-payout',
      settlementId: 'settlement-2',
      payload: validPayload('payout', ''),
    };

    await expect(
      router.submit('payout', { ...request, settlementCustodyMode: 'non_custodial' }),
    ).rejects.toBeInstanceOf(CustodyFirewallError);
    expect(payout.operations()).toBe(0);

    const allowed = await router.submit('payout', {
      ...request,
      settlementCustodyMode: 'licensed_custodial',
    });
    expect(allowed).toMatchObject({
      outcome: 'succeeded',
      custodyMode: 'licensed_custodial',
      configHash: router.readiness().configHash,
    });
    expect(payout.operations()).toBe(1);
  });
});

function fundingRouter(behaviour?: FakeBehaviour) {
  const provider = createFakeProvider('funding', { id: 'direct-usdc', behaviour });
  const alerts: ExecutionAlert[] = [];
  const router = createExecutionRouter({
    config: { custodyMode: 'non_custodial', adapters: { funding: 'direct-usdc' } },
    adapters: [provider.adapter] as AnyExecutionAdapter[],
    timeoutMs: 50,
    onAlert: (value) => alerts.push(value),
  });
  return { provider, router, alerts };
}

describe('idempotent submit', () => {
  test('a duplicate submit with one idempotency key performs one provider operation', async () => {
    const { provider, router } = fundingRouter();
    const request = fundingRequest('k-dup');

    const first = await router.submit('funding', request);
    const second = await router.submit('funding', request);

    expect(provider.operations()).toBe(1);
    expect(first).toMatchObject({ outcome: 'succeeded', operationRef: 'op-1', replayed: false });
    expect(second).toMatchObject({ outcome: 'succeeded', operationRef: 'op-1', replayed: true });
  });

  test('concurrent submits with one key perform one provider operation', async () => {
    const { provider, router } = fundingRouter();
    const request = fundingRequest('k-race');

    const results = await Promise.all([
      router.submit('funding', request),
      router.submit('funding', request),
      router.submit('funding', request),
    ]);

    expect(provider.operations()).toBe(1);
    expect(new Set(results.map((result) => result.operationRef))).toEqual(new Set(['op-1']));
  });

  test('reusing a key for a different request is a conflict', async () => {
    const { provider, router } = fundingRouter();
    await router.submit('funding', fundingRequest('k-reuse'));

    await expect(
      router.submit('funding', {
        ...fundingRequest('k-reuse'),
        payload: { ...fundingRequest('k-reuse').payload, amount: exactAmount(USDC, 7n) },
      }),
    ).rejects.toBeInstanceOf(ExecutionIdempotencyConflictError);
    expect(provider.operations()).toBe(1);
  });
});

describe('unknown outcomes', () => {
  test('a timeout returns unknown, is never retried blindly and recovers through status', async () => {
    const { provider, router, alerts } = fundingRouter('hang');
    const request = fundingRequest('k-timeout');

    const timedOut = await router.submit('funding', request);
    expect(timedOut).toMatchObject({ outcome: 'unknown', reason: 'timeout', operationRef: null });
    expect(alerts).toContainEqual(
      expect.objectContaining({ code: 'outcome_unknown', detail: 'timeout' }),
    );

    provider.setBehaviour('honest');
    const retried = await router.submit('funding', request);
    expect(retried).toMatchObject({ outcome: 'unknown', reason: 'timeout', replayed: true });
    expect(provider.operations()).toBe(1);

    const recovered = await router.status('funding', {
      idempotencyKey: 'k-timeout',
      settlementCustodyMode: 'non_custodial',
    });
    expect(recovered).toMatchObject({ outcome: 'succeeded', operationRef: 'op-1' });
    expect(await router.submit('funding', request)).toMatchObject({
      outcome: 'succeeded',
      operationRef: 'op-1',
      replayed: true,
    });
    expect(provider.operations()).toBe(1);
  });

  test('an adapter error after submit is unknown, not failed or succeeded', async () => {
    const { router } = fundingRouter('throw_on_submit');
    await expect(router.submit('funding', fundingRequest('k-throw'))).resolves.toMatchObject({
      outcome: 'unknown',
      reason: 'adapter_error',
    });
  });

  test('a pending operation becomes succeeded once the provider confirms it', async () => {
    const { provider, router } = fundingRouter('pending');
    const query = { idempotencyKey: 'k-pending', settlementCustodyMode: 'non_custodial' as const };

    expect(await router.submit('funding', fundingRequest('k-pending'))).toMatchObject({
      outcome: 'pending',
    });
    expect(await router.status('funding', query)).toMatchObject({ outcome: 'pending' });
    provider.complete('k-pending');
    expect(await router.status('funding', query)).toMatchObject({ outcome: 'succeeded' });
  });

  test('status for a key that was never submitted is rejected', async () => {
    const { router } = fundingRouter();
    await expect(
      router.status('funding', {
        idempotencyKey: 'k-none',
        settlementCustodyMode: 'non_custodial',
      }),
    ).rejects.toMatchObject({ rejection: 'no_submission_record' });
  });
});

describe('observation checks', () => {
  test.each([
    ['misreport_amount', 'observation_mismatch:amount_mismatch'],
    ['misreport_recipient', 'observation_mismatch:recipient_mismatch'],
    ['success_without_observation', 'observation_mismatch:observation_missing'],
  ] as const)('%s is rejected and alerted', async (behaviour, reason) => {
    const { router, alerts } = fundingRouter(behaviour);

    const result = await router.submit('funding', fundingRequest(`k-${behaviour}`));

    expect(result).toMatchObject({ outcome: 'unknown', reason });
    expect(alerts).toContainEqual(
      expect.objectContaining({ code: 'observation_mismatch', capability: 'funding' }),
    );
  });

  test('a signer that changes the approved intent is rejected through the #645 check', async () => {
    const signer = createFakeProvider('signing', { id: 'kms', behaviour: 'sign_other_nonce' });
    const router = createExecutionRouter({
      config: { custodyMode: 'non_custodial', adapters: { signing: 'kms' } },
      adapters: [signer.adapter] as AnyExecutionAdapter[],
    });

    const result = await router.submit('signing', {
      idempotencyKey: 'k-sign',
      settlementId: null,
      settlementCustodyMode: 'non_custodial',
      payload: { intent: signingIntent(7) },
    });

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'observation_mismatch:signature_nonce',
    });
  });
});

describe('exact amounts', () => {
  test.each([['1.5'], ['-1'], ['01'], ['1e6'], [' 1'], ['']])('rejects %p', (value) => {
    expect(() => exactAmount(USDC, value)).toThrow('canonical base-unit integer');
  });

  test('rejects numbers even when integral', () => {
    expect(() => exactAmount(USDC, 1_000_000 as unknown as string)).toThrow('never a number');
  });

  test('keeps values above Number.MAX_SAFE_INTEGER exact', () => {
    expect(exactAmount(USDC, '9007199254740993').baseUnits).toBe(9007199254740993n);
  });

  test('the router rejects a payload whose amount is not exact', async () => {
    const { provider, router } = fundingRouter();
    await expect(
      router.submit('funding', {
        ...fundingRequest('k-float'),
        payload: {
          chainId: 84532,
          payerRef: 'buyer',
          destination: ESCROW,
          amount: { asset: USDC, baseUnits: 1.5 } as never,
        },
      }),
    ).rejects.toBeInstanceOf(ExecutionRoutingError);
    expect(provider.operations()).toBe(0);
  });
});

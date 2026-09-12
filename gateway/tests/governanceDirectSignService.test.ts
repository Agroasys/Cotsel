/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'ethers';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { GovernanceMutationService } from '../src/core/governanceMutationService';
import type {
  GovernanceObservedTransaction,
  GovernanceTransactionVerifier,
} from '../src/core/governanceMutationTypes';
import { createInMemoryGovernanceActionStore } from '../src/core/governanceInMemoryStore';
import { createPassthroughGovernanceWriteStore } from '../src/core/governanceWriteStore';
import type { AuthorizedSignerBinding, GatewayPrincipal } from '../src/middleware/auth';
import { baseTestGatewayConfig } from './support/testConfig';

const signerWallet = getAddress('0x00000000000000000000000000000000000000aa');
const escrowAddress = getAddress('0x00000000000000000000000000000000000000ff');

function authorizedSignerBinding(bindingId = 'binding-admin-1'): AuthorizedSignerBinding {
  return {
    bindingId,
    walletAddress: signerWallet,
    actionClass: 'governance',
    environment: 'staging',
    approvedAt: '2026-09-11T08:00:00.000Z',
    approvedBy: 'security-owner',
    ticketRef: 'WP1-641',
    notes: null,
    policy: {
      required: true,
      result: 'authorized',
      actionClass: 'governance',
      environment: 'staging',
      reason: null,
      breakGlassActive: false,
      breakGlassReason: null,
      breakGlassExpiresAt: null,
    },
  };
}

function principal(): GatewayPrincipal {
  return {
    sessionReference: 'sha256:session',
    session: {
      userId: 'uid-admin',
      accountId: 'acct-admin',
      walletAddress: signerWallet,
      role: 'admin',
      capabilities: ['governance:write'],
      signerAuthorizations: [authorizedSignerBinding()],
      breakGlass: {
        active: false,
        role: null,
        expiresAt: null,
        grantedAt: null,
        grantedBy: null,
        reason: null,
        revokedAt: null,
        revokedBy: null,
        reviewedAt: null,
        reviewedBy: null,
        reviewStatus: 'none',
      },
      issuedAt: 1,
      expiresAt: 2,
    },
    gatewayRoles: ['operator:read', 'operator:write'],
    operatorActionCapabilities: ['governance:write'],
    treasuryCapabilities: [],
    writeEnabled: true,
  };
}

function observed(
  overrides: Partial<GovernanceObservedTransaction> = {},
): GovernanceObservedTransaction {
  return {
    chainId: 31337,
    to: escrowAddress,
    from: signerWallet,
    data: '0x',
    value: '0',
    nonce: 7,
    blockNumber: 100,
    ...overrides,
  };
}

function createHarness(transaction: GovernanceObservedTransaction | null = null) {
  const actionStore = createInMemoryGovernanceActionStore();
  const auditStore = createInMemoryAuditLogStore();
  const writeStore = createPassthroughGovernanceWriteStore(actionStore, auditStore);
  const verifier: GovernanceTransactionVerifier = {
    getTransactionCount: jest.fn(async () => 7),
    getTransaction: jest.fn(async () => transaction),
    getTransactionReceipt: jest.fn(async () => null),
    getBlockNumber: jest.fn(async () => null),
  };
  const config = {
    ...baseTestGatewayConfig,
    escrowAddress,
    nodeEnv: 'test',
    operatorSignerEnvironment: 'staging',
    governancePreparationTtlSeconds: 900,
  };
  return {
    actionStore,
    auditStore,
    verifier,
    service: new GovernanceMutationService(config, actionStore, writeStore, verifier),
  };
}

async function prepare(harness: ReturnType<typeof createHarness>) {
  return harness.service.prepareAction({
    category: 'pause',
    contractMethod: 'pause',
    routePath: '/governance/pause/prepare',
    audit: {
      reason: 'Prepare witnessed hardware-wallet governance action.',
      ticketRef: 'WP1-641',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/WP1-641' }],
    },
    principal: principal(),
    signerWallet,
    signerBinding: authorizedSignerBinding(),
    requestContext: { requestId: 'req-1', correlationId: 'corr-1', startedAtMs: 1 },
    idempotencyKey: 'idem-1',
  });
}

describe('GovernanceMutationService direct-sign boundary', () => {
  test('binds the prepared payload to action, audit, chain, contract, sender, calldata, nonce and expiry', async () => {
    const harness = createHarness();
    const result = await prepare(harness);

    expect(result.status).toBe('prepared');
    expect(result.signing).toMatchObject({
      actionId: result.actionId,
      intentKey: result.intentKey,
      actionType: 'pause',
      proposalId: null,
      auditReference: 'WP1-641',
      chainId: 31337,
      contractAddress: escrowAddress,
      contractMethod: 'pause',
      signerWallet,
      txRequest: {
        chainId: 31337,
        from: signerWallet,
        to: escrowAddress,
        value: '0',
        nonce: 7,
      },
    });
    expect(result.signing.expiresAt).toBe(result.expiresAt);
    expect(result.signing.txRequest.data).toMatch(/^0x[0-9a-f]+$/);
    expect(result.signing.preparedPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.verifier.getTransactionCount).toHaveBeenCalledWith(signerWallet);
    expect(harness.auditStore.entries[0]).toMatchObject({
      eventType: 'governance.action.prepared',
      status: 'prepared',
    });
  });

  test.each([
    ['chain', { chainId: 1 }, 'chain'],
    ['contract', { to: '0x0000000000000000000000000000000000000011' }, 'target'],
    ['signer', { from: '0x0000000000000000000000000000000000000011' }, 'signer'],
    ['value', { value: '1' }, 'value'],
    ['nonce', { nonce: 8 }, 'nonce'],
  ] as const)(
    'rejects a broadcast with the wrong %s',
    async (_label, overrides, expectedMessage) => {
      const harness = createHarness();
      const prepared = await prepare(harness);
      (harness.verifier.getTransaction as jest.Mock).mockResolvedValue(
        observed({ ...overrides, data: prepared.signing.txRequest.data }),
      );

      await expect(
        harness.service.confirmBroadcast({
          actionId: prepared.actionId,
          txHash: `0x${'1'.repeat(64)}`,
          signerWallet,
          principal: principal(),
          signerBinding: authorizedSignerBinding(),
          requestContext: { requestId: 'req-2', correlationId: 'corr-2', startedAtMs: 2 },
        }),
      ).rejects.toThrow(expectedMessage);
    },
  );

  test('rejects mismatched calldata and duplicate confirmation with a different transaction hash', async () => {
    const harness = createHarness();
    const prepared = await prepare(harness);
    (harness.verifier.getTransaction as jest.Mock).mockResolvedValue(
      observed({ data: '0xdeadbeef' }),
    );
    await expect(
      harness.service.confirmBroadcast({
        actionId: prepared.actionId,
        txHash: `0x${'1'.repeat(64)}`,
        signerWallet,
        principal: principal(),
        signerBinding: authorizedSignerBinding(),
        requestContext: { requestId: 'req-2', correlationId: 'corr-2', startedAtMs: 2 },
      }),
    ).rejects.toThrow('calldata');

    (harness.verifier.getTransaction as jest.Mock).mockResolvedValue(
      observed({ data: prepared.signing.txRequest.data }),
    );
    await harness.service.confirmBroadcast({
      actionId: prepared.actionId,
      txHash: `0x${'2'.repeat(64)}`,
      signerWallet,
      principal: principal(),
      signerBinding: authorizedSignerBinding(),
      requestContext: { requestId: 'req-3', correlationId: 'corr-3', startedAtMs: 3 },
    });
    await expect(
      harness.service.confirmBroadcast({
        actionId: prepared.actionId,
        txHash: `0x${'3'.repeat(64)}`,
        signerWallet,
        principal: principal(),
        signerBinding: authorizedSignerBinding(),
        requestContext: { requestId: 'req-4', correlationId: 'corr-4', startedAtMs: 4 },
      }),
    ).rejects.toThrow('different transaction hash');
  });

  test('rejects a stored prepared payload whose action binding or hash was changed', async () => {
    const harness = createHarness();
    const prepared = await prepare(harness);
    const stored = await harness.actionStore.get(prepared.actionId);
    await harness.actionStore.save({
      ...stored!,
      signing: { ...stored!.signing!, auditReference: 'ATTACK-1' },
    });

    await expect(
      harness.service.confirmBroadcast({
        actionId: prepared.actionId,
        txHash: `0x${'4'.repeat(64)}`,
        signerWallet,
        principal: principal(),
        signerBinding: authorizedSignerBinding(),
        requestContext: { requestId: 'req-5', correlationId: 'corr-5', startedAtMs: 5 },
      }),
    ).rejects.toThrow('integrity check');
  });

  test('rejects confirmation after the prepared signer binding is replaced', async () => {
    const harness = createHarness();
    const prepared = await prepare(harness);

    await expect(
      harness.service.confirmBroadcast({
        actionId: prepared.actionId,
        txHash: `0x${'5'.repeat(64)}`,
        signerWallet,
        principal: principal(),
        signerBinding: authorizedSignerBinding('replacement-binding'),
        requestContext: { requestId: 'req-6', correlationId: 'corr-6', startedAtMs: 6 },
      }),
    ).rejects.toThrow('same active signer binding');
  });

  test('contains no signer, executor, queue or broadcast capability', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/core/governanceMutationService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/KMS|kms:Sign|broadcastTransaction|privateKey|queueAction/);
  });
});

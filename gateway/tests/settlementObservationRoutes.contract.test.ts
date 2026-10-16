/** SPDX-License-Identifier: Apache-2.0 */
import { JsonRpcProvider } from 'ethers';
import * as chainFinality from '../src/core/gaslessChainFinality';
import { createSchemaValidator } from '../src/openapi/contract';
import { loadOpenApiSpec } from '../src/openapi/spec';
import {
  executionBindingFixture,
  fundedBindingFixture,
} from './helpers/settlementExecutionBindingFixtures';
import {
  buildGaslessCreateTradeBody,
  config,
  startServer,
  withServiceAuth,
} from './helpers/settlementRoutesFixture';

// HTTP/authentication contract probes with controlled chain inputs; not live financial acceptance.
describe('retained settlement observation and mandatory binding contracts', () => {
  afterEach(() => jest.restoreAllMocks());
  test('keeps authenticated finality reads available when issuance is disabled', async () => {
    const transactionHash = `0x${'a'.repeat(64)}`;
    const blockHash = `0x${'b'.repeat(64)}`;
    const evidence = {
      policyVersion: 'gasless_dual_rpc_finalized_v1' as const,
      chainId: String(config.chainId),
      transactionHash,
      blockNumber: '100',
      blockHash,
      finalizedBlockNumber: '110',
      finalizedBlockHash: blockHash,
      rpcWitnesses: [`0x${'c'.repeat(64)}`, `0x${'d'.repeat(64)}`],
      projectionCoverage: {
        version: 'cotsel.financial-projection-coverage.v1' as const,
        tradeId: '7',
        indexer: { blockNumber: '110', blockHash },
        reconciliation: {
          runKey: 'retained-run',
          blockNumber: '110',
          blockHash,
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    const verifyReceipt = jest.fn().mockResolvedValue(evidence);
    jest
      .spyOn(chainFinality, 'createGaslessFinalityVerifier')
      .mockReturnValue({ verifyReceipt, revalidateBlock: jest.fn() });
    const receipt = { status: 1, to: config.escrowAddress };
    jest
      .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
      .mockResolvedValue(receipt as never);
    const { server, baseUrl } = await startServer({
      settlementIngressEnabled: false,
      gaslessExecutionEnabled: false,
    });
    const suffix = `/settlement/transactions/${transactionHash}/finality`;
    const canonicalPath = `/api/dashboard-gateway/v1${suffix}`;
    try {
      expect((await fetch(baseUrl + suffix)).status).toBe(401);
      expect(verifyReceipt).not.toHaveBeenCalled();
      const response = await fetch(baseUrl + suffix, {
        headers: { ...withServiceAuth(canonicalPath, null, 'GET') },
      });
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(
        createSchemaValidator(
          loadOpenApiSpec(),
          '#/components/schemas/SettlementFinalityEvidence',
        )(payload.data),
      ).toBe(true);
      expect(verifyReceipt).toHaveBeenCalledWith(config.chainId, transactionHash, receipt);
      expect(
        (
          await fetch(`${baseUrl}/settlement/handoffs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403);
      verifyReceipt.mockResolvedValue(null);
      expect(
        (
          await fetch(baseUrl + suffix, {
            headers: { ...withServiceAuth(canonicalPath, null, 'GET') },
          })
        ).status,
      ).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('binds signed historical query identity and rejects unapproved observation targets', async () => {
    const transactionHash = `0x${'a'.repeat(64)}`;
    const oldEscrow = `0x${'1'.repeat(40)}`;
    const retained = {
      chainId: 84532,
      escrowAddress: oldEscrow,
      usdcAddress: `0x${'2'.repeat(40)}`,
      rpcUrl: 'https://old-primary.example.test',
      rpcFallbackUrls: ['https://old-witness.example.test'],
      indexerCoverageUrl: 'https://old-indexer.example.test',
      reconciliationCoverageUrl: 'https://old-reconciliation.example.test',
      railManifestSha256: 'a'.repeat(64),
    };
    const verifyReceipt = jest.fn().mockResolvedValue({
      projectionCoverage: { tradeId: '7' },
      chainId: '84532',
      transactionHash,
    });
    jest
      .spyOn(chainFinality, 'createGaslessFinalityVerifier')
      .mockReturnValue({ verifyReceipt, revalidateBlock: jest.fn() });
    const readReceipt = jest
      .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
      .mockResolvedValue({ status: 1, to: oldEscrow } as never);
    const { server, baseUrl } = await startServer({
      retainedSettlementRails: [retained],
      settlementIngressEnabled: false,
    });
    const suffix = `/settlement/transactions/${transactionHash}/finality`;
    const path = `/api/dashboard-gateway/v1${suffix}`;
    const query = `chainId=84532&escrowAddress=${oldEscrow}`;
    try {
      expect(
        (
          await fetch(`${baseUrl}${suffix}?${query}`, {
            headers: { ...withServiceAuth(path, null, 'GET', query) },
          })
        ).status,
      ).toBe(200);
      expect(verifyReceipt).toHaveBeenCalledWith(
        84532,
        transactionHash,
        expect.objectContaining({ to: oldEscrow }),
      );
      const before = readReceipt.mock.calls.length;
      const unapproved = `chainId=1&escrowAddress=${oldEscrow}`;
      expect(
        (
          await fetch(`${baseUrl}${suffix}?${unapproved}`, {
            headers: { ...withServiceAuth(path, null, 'GET', unapproved) },
          })
        ).status,
      ).toBe(503);
      expect(readReceipt).toHaveBeenCalledTimes(before);
      expect(
        (
          await fetch(`${baseUrl}${suffix}?${query}`, {
            headers: { ...withServiceAuth(path, null, 'GET') },
          })
        ).status,
      ).toBe(401);
      const invalid = `${query}&rpcUrl=https%3A%2F%2Fattacker.example`;
      expect(
        (
          await fetch(`${baseUrl}${suffix}?${invalid}`, {
            headers: { ...withServiceAuth(path, null, 'GET', invalid) },
          })
        ).status,
      ).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.each(['missing', 'wrong-owner', 'unknown-field', 'different-operation'])(
    'rejects %s binding at authenticated registration',
    async (fault) => {
      const { server, baseUrl } = await startServer();
      const request = buildGaslessCreateTradeBody('pending');
      const binding: Record<string, unknown> = {
        ...executionBindingFixture(request as never, 'platform-main', config.usdcAddress),
      };
      const body: Record<string, unknown> = {
        platformId: 'agroasys-platform',
        platformHandoffId: `controlled-${fault}`,
        tradeId: 'order:42',
        phase: 'gasless_create_trade',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 1000,
        ricardianHash: request.ricardianHash,
        externalReference: 'controlled-operation',
        executionBinding: binding,
      };
      if (fault === 'missing') delete body.executionBinding;
      if (fault === 'wrong-owner') binding.ownerServiceId = 'foreign-service';
      if (fault === 'unknown-field') binding.unapprovedInstruction = true;
      if (fault === 'different-operation') binding.sourceOperationId = 'another-operation';
      const path = '/api/dashboard-gateway/v1/settlement/handoffs';
      try {
        const response = await fetch(`${baseUrl}/settlement/handoffs`, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `controlled-${fault}`,
            ...withServiceAuth(path, body),
          },
        });
        expect(response.status).toBe(
          fault === 'wrong-owner' ? 403 : fault === 'different-operation' ? 409 : 400,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  test.each([
    'valid',
    'missing',
    'owner',
    'trade',
    'phase',
    'amount',
    'supplier',
    'extra',
    'unsafe-chain',
  ])('funded progression registration enforces %s scope', async (fault) => {
    const { server, baseUrl } = await startServer();
    const binding: Record<string, unknown> = {
      ...fundedBindingFixture(),
      totalAmount: '10000000',
      logisticsAmount: '1000000',
      platformFeesAmount: '500000',
      supplierFirstTranche: '3500000',
      supplierSecondTranche: '5000000',
      supplierPayoutAmount: '3500000',
      treasuryAccrualAmount: '1500000',
    };
    const body: Record<string, unknown> = {
      platformId: 'agroasys-platform',
      platformHandoffId: '42',
      tradeId: '9001',
      phase: binding.phase,
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: '5.00',
      assetSymbol: 'USDC',
      assetAmount: '5.000000',
      ricardianHash: binding.ricardianHash,
      externalReference: '9001',
      metadata: {},
      executionBinding: binding,
    };
    if (fault === 'missing') delete body.executionBinding;
    if (fault === 'owner') binding.ownerServiceId = 'foreign-service';
    if (fault === 'trade') binding.tradeId = '9002';
    if (fault === 'phase') body.phase = 'inspection_available_standard';
    if (fault === 'amount') body.displayAmount = '5.01';
    if (fault === 'supplier') binding.supplierPayoutAmount = '3500001';
    if (fault === 'extra') binding.clientOverride = true;
    if (fault === 'unsafe-chain') binding.chainId = '9007199254740992';
    const suffix = '/settlement/handoffs';
    const path = '/api/dashboard-gateway/v1' + suffix;
    try {
      const response = await fetch(baseUrl + suffix, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'funded-proof-' + fault,
          ...withServiceAuth(path, body),
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(
        fault === 'valid'
          ? 202
          : fault === 'owner'
            ? 403
            : ['trade', 'phase', 'amount'].includes(fault)
              ? 409
              : 400,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

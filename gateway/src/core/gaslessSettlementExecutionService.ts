/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  Contract,
  getAddress,
  isAddress,
  isHexString,
  JsonRpcProvider,
  keccak256,
  NonceManager,
  toUtf8Bytes,
  Wallet,
  ZeroAddress,
} from 'ethers';
import { createManagedRpcProvider } from '@agroasys/sdk/rpc/failoverProvider';
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import { SettlementService } from './settlementService';
import {
  SettlementExecutionEventRecord,
  SettlementHandoffRecord,
  SettlementStore,
} from './settlementStore';

const GASLESS_ESCROW_ABI = [
  'function createTradeWithAuthorization(address _buyer,address _supplierAddress,uint256 _totalAmount,uint256 _logisticsAmount,uint256 _platformFeesAmount,uint256 _supplierFirstTranche,uint256 _supplierSecondTranche,bytes32 _ricardianHash,uint256 _authorizationNonce,uint256 _authorizationDeadline,bytes _buyerAuthorizationSignature,(uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) _usdcAuthorization) returns (uint256)',
];

const HEX_32_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export interface GaslessBuyerAuthorization {
  nonce: string;
  deadline: string;
  signature: string;
}

export interface GaslessUsdcAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  v: number;
  r: string;
  s: string;
}

export interface GaslessCreateTradeExecutionInput {
  action: 'create_trade';
  handoffId: string;
  chainId: number;
  contractAddress: string;
  expiresAt: string;
  payloadHash: string;
  buyerAddress: string;
  supplierAddress: string;
  totalAmount: string;
  logisticsAmount: string;
  platformFeesAmount: string;
  supplierFirstTranche: string;
  supplierSecondTranche: string;
  ricardianHash: string;
  buyerAuthorization: GaslessBuyerAuthorization;
  usdcAuthorization: GaslessUsdcAuthorization;
  requestId: string;
  sourceApiKeyId?: string | null;
}

type GaslessCreateTradePayload = Omit<
  GaslessCreateTradeExecutionInput,
  'payloadHash' | 'requestId' | 'sourceApiKeyId'
>;

export interface GaslessCreateTradeExecutionResult {
  handoff: SettlementHandoffRecord;
  acceptedEvent: SettlementExecutionEventRecord;
  queuedEvent: SettlementExecutionEventRecord;
  simulationEvent: SettlementExecutionEventRecord;
  submittedEvent: SettlementExecutionEventRecord;
  txHash: string;
}

export interface GaslessSettlementExecutor {
  simulateCreateTrade(
    input: GaslessCreateTradeExecutionInput,
  ): Promise<{ gasEstimate?: bigint | string | number | null }>;
  executeCreateTrade(input: GaslessCreateTradeExecutionInput): Promise<{ txHash: string }>;
}

function requireAddress(value: string, field: string): string {
  if (!isAddress(value) || value === ZeroAddress) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid non-zero address`, {
      field,
    });
  }

  return getAddress(value);
}

function requireUint(value: string, field: string): string {
  if (!/^\d+$/.test(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an unsigned integer string`, {
      field,
    });
  }

  return BigInt(value).toString();
}

function requireBytes32(value: string, field: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a 32-byte hex string`, {
      field,
    });
  }

  return value;
}

function requireSignature(value: string, field: string): string {
  if (!isHexString(value) || value.length < 132) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a hex signature`, { field });
  }

  return value;
}

function requireRecoveryId(value: number, field: string): number {
  if (!Number.isInteger(value) || (value !== 27 && value !== 28)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be 27 or 28`, { field });
  }

  return value;
}

function requireAction(value: string, field: string): 'create_trade' {
  if (value !== 'create_trade') {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} is not supported`, {
      field,
      allowed: ['create_trade'],
    });
  }

  return value;
}

function requireChainId(value: number, expected: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'chainId must be a positive integer', {
      field: 'chainId',
    });
  }

  if (value !== expected) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'chainId does not match Cotsel runtime', {
      chainId: value,
      expectedChainId: expected,
    });
  }

  return value;
}

function parseExpiry(value: string, maxTtlSeconds: number, now: Date): string {
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'expiresAt must be an ISO-8601 timestamp', {
      field: 'expiresAt',
    });
  }

  if (expiresAt.getTime() <= now.getTime()) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'gasless execution request has expired', {
      field: 'expiresAt',
      expiresAt: expiresAt.toISOString(),
    });
  }

  const maxExpiry = now.getTime() + maxTtlSeconds * 1000;
  if (expiresAt.getTime() > maxExpiry) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'expiresAt exceeds gasless request TTL', {
      field: 'expiresAt',
      maxTtlSeconds,
    });
  }

  return expiresAt.toISOString();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function createPayloadHash(input: GaslessCreateTradePayload): string {
  return keccak256(toUtf8Bytes(stableJson(input)));
}

function normalizeInput(input: GaslessCreateTradeExecutionInput): GaslessCreateTradeExecutionInput {
  return {
    ...input,
    action: requireAction(input.action, 'action'),
    handoffId: input.handoffId.trim(),
    contractAddress: requireAddress(input.contractAddress, 'contractAddress'),
    payloadHash: requireBytes32(input.payloadHash, 'payloadHash'),
    buyerAddress: requireAddress(input.buyerAddress, 'buyerAddress'),
    supplierAddress: requireAddress(input.supplierAddress, 'supplierAddress'),
    totalAmount: requireUint(input.totalAmount, 'totalAmount'),
    logisticsAmount: requireUint(input.logisticsAmount, 'logisticsAmount'),
    platformFeesAmount: requireUint(input.platformFeesAmount, 'platformFeesAmount'),
    supplierFirstTranche: requireUint(input.supplierFirstTranche, 'supplierFirstTranche'),
    supplierSecondTranche: requireUint(input.supplierSecondTranche, 'supplierSecondTranche'),
    ricardianHash: requireBytes32(input.ricardianHash, 'ricardianHash'),
    buyerAuthorization: {
      nonce: requireUint(input.buyerAuthorization.nonce, 'buyerAuthorization.nonce'),
      deadline: requireUint(input.buyerAuthorization.deadline, 'buyerAuthorization.deadline'),
      signature: requireSignature(
        input.buyerAuthorization.signature,
        'buyerAuthorization.signature',
      ),
    },
    usdcAuthorization: {
      from: requireAddress(input.usdcAuthorization.from, 'usdcAuthorization.from'),
      to: requireAddress(input.usdcAuthorization.to, 'usdcAuthorization.to'),
      value: requireUint(input.usdcAuthorization.value, 'usdcAuthorization.value'),
      validAfter: requireUint(input.usdcAuthorization.validAfter, 'usdcAuthorization.validAfter'),
      validBefore: requireUint(
        input.usdcAuthorization.validBefore,
        'usdcAuthorization.validBefore',
      ),
      nonce: requireBytes32(input.usdcAuthorization.nonce, 'usdcAuthorization.nonce'),
      v: requireRecoveryId(input.usdcAuthorization.v, 'usdcAuthorization.v'),
      r: requireBytes32(input.usdcAuthorization.r, 'usdcAuthorization.r'),
      s: requireBytes32(input.usdcAuthorization.s, 'usdcAuthorization.s'),
    },
  };
}

function assertAmountsMatchAuthorization(input: GaslessCreateTradeExecutionInput): void {
  const expectedTotal =
    BigInt(input.logisticsAmount) +
    BigInt(input.platformFeesAmount) +
    BigInt(input.supplierFirstTranche) +
    BigInt(input.supplierSecondTranche);

  if (BigInt(input.totalAmount) !== expectedTotal) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'totalAmount must match settlement amount breakdown',
      {
        totalAmount: input.totalAmount,
        expectedTotal: expectedTotal.toString(),
      },
    );
  }

  if (input.totalAmount !== input.usdcAuthorization.value) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'totalAmount must match usdcAuthorization.value',
      {
        totalAmount: input.totalAmount,
        usdcAuthorizationValue: input.usdcAuthorization.value,
      },
    );
  }
}

function assertAuthorizationBindings(input: GaslessCreateTradeExecutionInput, now: Date): void {
  if (input.usdcAuthorization.from !== input.buyerAddress) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'buyerAddress must match usdcAuthorization.from',
      {
        buyerAddress: input.buyerAddress,
        usdcAuthorizationFrom: input.usdcAuthorization.from,
      },
    );
  }

  if (input.usdcAuthorization.to !== input.contractAddress) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'usdcAuthorization.to must match contractAddress',
      {
        contractAddress: input.contractAddress,
        usdcAuthorizationTo: input.usdcAuthorization.to,
      },
    );
  }

  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (BigInt(input.buyerAuthorization.deadline) <= nowSeconds) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'buyerAuthorization.deadline has expired', {
      buyerAuthorizationDeadline: input.buyerAuthorization.deadline,
    });
  }

  if (BigInt(input.usdcAuthorization.validAfter) > nowSeconds) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'usdcAuthorization.validAfter is in the future',
      {
        usdcAuthorizationValidAfter: input.usdcAuthorization.validAfter,
      },
    );
  }

  if (BigInt(input.usdcAuthorization.validBefore) <= nowSeconds) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'usdcAuthorization.validBefore has expired', {
      usdcAuthorizationValidBefore: input.usdcAuthorization.validBefore,
    });
  }
}

function assertHandoffMatchesExecution(
  handoff: SettlementHandoffRecord,
  input: GaslessCreateTradeExecutionInput,
): void {
  if (handoff.ricardianHash && handoff.ricardianHash !== input.ricardianHash) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'gasless execution ricardianHash does not match settlement handoff',
      {
        handoffId: handoff.handoffId,
        handoffRicardianHash: handoff.ricardianHash,
        ricardianHash: input.ricardianHash,
      },
    );
  }
}

function assertContractMatchesRuntime(
  input: GaslessCreateTradeExecutionInput,
  expectedContractAddress: string,
): void {
  const expected = getAddress(expectedContractAddress);
  if (input.contractAddress !== expected) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'contractAddress is not allowlisted', {
      contractAddress: input.contractAddress,
      expectedContractAddress: expected,
    });
  }
}

function assertPayloadHash(input: GaslessCreateTradeExecutionInput): void {
  const {
    payloadHash: _payloadHash,
    requestId: _requestId,
    sourceApiKeyId: _sourceApiKeyId,
    ...hashable
  } = input;
  const expectedPayloadHash = createPayloadHash(hashable);
  if (input.payloadHash !== expectedPayloadHash) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'payloadHash does not match request payload', {
      payloadHash: input.payloadHash,
      expectedPayloadHash,
    });
  }
}

function serializeGasEstimate(value: bigint | string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return BigInt(value).toString();
}

function buildCreateTradeArguments(input: GaslessCreateTradeExecutionInput) {
  return [
    input.buyerAddress,
    input.supplierAddress,
    input.totalAmount,
    input.logisticsAmount,
    input.platformFeesAmount,
    input.supplierFirstTranche,
    input.supplierSecondTranche,
    input.ricardianHash,
    input.buyerAuthorization.nonce,
    input.buyerAuthorization.deadline,
    input.buyerAuthorization.signature,
    {
      validAfter: input.usdcAuthorization.validAfter,
      validBefore: input.usdcAuthorization.validBefore,
      nonce: input.usdcAuthorization.nonce,
      v: input.usdcAuthorization.v,
      r: input.usdcAuthorization.r,
      s: input.usdcAuthorization.s,
    },
  ] as const;
}

export class GaslessSettlementExecutionService {
  constructor(
    private readonly settlementService: SettlementService,
    private readonly store: SettlementStore,
    private readonly executor: GaslessSettlementExecutor,
    private readonly options: {
      chainId: number;
      escrowAddress: string;
      requestMaxTtlSeconds: number;
      now?: () => Date;
    },
  ) {}

  async executeCreateTrade(
    input: GaslessCreateTradeExecutionInput,
  ): Promise<GaslessCreateTradeExecutionResult> {
    const now = this.options.now?.() ?? new Date();
    const normalized = normalizeInput({
      ...input,
      chainId: requireChainId(input.chainId, this.options.chainId),
      expiresAt: parseExpiry(input.expiresAt, this.options.requestMaxTtlSeconds, now),
    });
    assertAmountsMatchAuthorization(normalized);
    assertContractMatchesRuntime(normalized, this.options.escrowAddress);
    assertAuthorizationBindings(normalized, now);
    assertPayloadHash(normalized);

    const handoff = await this.store.getHandoff(normalized.handoffId);
    if (!handoff) {
      throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', {
        handoffId: normalized.handoffId,
      });
    }
    assertHandoffMatchesExecution(handoff, normalized);

    const accepted = await this.settlementService.recordExecutionEvent({
      handoffId: normalized.handoffId,
      eventType: 'accepted',
      executionStatus: 'accepted',
      reconciliationStatus: handoff.reconciliationStatus,
      providerStatus: 'gasless_request_accepted',
      detail: 'Gasless create-trade request accepted by Cotsel execution service.',
      metadata: {
        action: 'create_trade',
        chainId: normalized.chainId,
        contractAddress: normalized.contractAddress,
        expiresAt: normalized.expiresAt,
        payloadHash: normalized.payloadHash,
        buyerAddress: normalized.buyerAddress,
        supplierAddress: normalized.supplierAddress,
        ricardianHash: normalized.ricardianHash,
      },
      observedAt: new Date().toISOString(),
      requestId: normalized.requestId,
      sourceApiKeyId: normalized.sourceApiKeyId,
    });

    try {
      const queued = await this.settlementService.recordExecutionEvent({
        handoffId: normalized.handoffId,
        eventType: 'queued',
        executionStatus: 'queued',
        reconciliationStatus: accepted.handoff.reconciliationStatus,
        providerStatus: 'gasless_request_queued',
        detail: 'Gasless create-trade request queued for simulation.',
        metadata: {
          action: 'create_trade',
          payloadHash: normalized.payloadHash,
        },
        observedAt: new Date().toISOString(),
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      });

      const simulation = await this.executor.simulateCreateTrade(normalized);
      const simulationEvent = await this.settlementService.recordExecutionEvent({
        handoffId: normalized.handoffId,
        eventType: 'simulation_completed',
        executionStatus: 'queued',
        reconciliationStatus: queued.handoff.reconciliationStatus,
        providerStatus: 'gasless_simulation_completed',
        detail: 'Gasless create-trade transaction simulation completed.',
        metadata: {
          action: 'create_trade',
          gasEstimate: serializeGasEstimate(simulation.gasEstimate),
          payloadHash: normalized.payloadHash,
        },
        observedAt: new Date().toISOString(),
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      });

      const execution = await this.executor.executeCreateTrade(normalized);
      const submitted = await this.settlementService.recordExecutionEvent({
        handoffId: normalized.handoffId,
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: simulationEvent.handoff.reconciliationStatus,
        providerStatus: 'gasless_broadcast_submitted',
        txHash: execution.txHash,
        detail: 'Gasless create-trade transaction submitted by Cotsel.',
        metadata: {
          action: 'create_trade',
          usdcAuthorizationNonce: normalized.usdcAuthorization.nonce,
          payloadHash: normalized.payloadHash,
        },
        observedAt: new Date().toISOString(),
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      });

      return {
        handoff: submitted.handoff,
        acceptedEvent: accepted.event,
        queuedEvent: queued.event,
        simulationEvent: simulationEvent.event,
        submittedEvent: submitted.event,
        txHash: execution.txHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown gasless execution failure';
      await this.settlementService.recordExecutionEvent({
        handoffId: normalized.handoffId,
        eventType: 'failed',
        executionStatus: 'failed',
        reconciliationStatus: accepted.handoff.reconciliationStatus,
        providerStatus: 'gasless_broadcast_failed',
        detail: message,
        metadata: {
          action: 'create_trade',
          payloadHash: normalized.payloadHash,
        },
        observedAt: new Date().toISOString(),
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      });
      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Gasless execution failed', {
        reason: message,
      });
    }
  }
}

export function createEthersGaslessSettlementExecutor(
  config: Pick<
    GatewayConfig,
    | 'rpcUrl'
    | 'rpcFallbackUrls'
    | 'chainId'
    | 'escrowAddress'
    | 'gaslessExecutorPrivateKey'
    | 'gaslessMaxGasLimit'
    | 'gaslessMinExecutorBalanceWei'
  >,
): GaslessSettlementExecutor {
  if (!config.gaslessExecutorPrivateKey) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless executor signer is not configured',
    );
  }

  const provider = createManagedRpcProvider(config.rpcUrl, config.rpcFallbackUrls, {
    chainId: config.chainId,
  }) as JsonRpcProvider;
  const signer = new NonceManager(new Wallet(config.gaslessExecutorPrivateKey, provider));
  const escrow = new Contract(config.escrowAddress, GASLESS_ESCROW_ABI, signer);
  const gaslessMaxGasLimit = config.gaslessMaxGasLimit ?? 1_500_000n;
  const gaslessMinExecutorBalanceWei = config.gaslessMinExecutorBalanceWei ?? 0n;

  async function assertSignerBalance(): Promise<void> {
    const balance = await provider.getBalance(await signer.getAddress());
    if (balance < gaslessMinExecutorBalanceWei) {
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Gasless executor balance is below floor',
        {
          balanceWei: balance.toString(),
          minBalanceWei: gaslessMinExecutorBalanceWei.toString(),
        },
      );
    }
  }

  async function simulate(input: GaslessCreateTradeExecutionInput): Promise<bigint> {
    await assertSignerBalance();
    const args = buildCreateTradeArguments(input);
    await escrow.createTradeWithAuthorization.staticCall(...args);
    const gasEstimate = await escrow.createTradeWithAuthorization.estimateGas(...args);
    if (gasEstimate > gaslessMaxGasLimit) {
      throw new GatewayError(
        400,
        'VALIDATION_ERROR',
        'Gasless create-trade gas estimate exceeds cap',
        {
          gasEstimate: gasEstimate.toString(),
          gasCap: gaslessMaxGasLimit.toString(),
        },
      );
    }

    return gasEstimate;
  }

  return {
    async simulateCreateTrade(input) {
      return {
        gasEstimate: await simulate(input),
      };
    },

    async executeCreateTrade(input) {
      const args = buildCreateTradeArguments(input);
      const gasEstimate = await simulate(input);
      const tx = await escrow.createTradeWithAuthorization(...args, {
        gasLimit: gasEstimate,
      });

      return {
        txHash: tx.hash,
      };
    },
  };
}

export const testExports = {
  createPayloadHash,
  GASLESS_ESCROW_ABI,
  buildCreateTradeArguments,
};

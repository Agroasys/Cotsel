import { randomUUID } from 'crypto';
import {
  buildManagedSignerIntentHash,
  ManagedSignerValidationAuditRecord,
  ManagedSignerValidationError,
  ManagedSignerTransactionIntent,
  validateManagedSignerResponse,
} from '@agroasys/sdk';
import { ethers } from 'ethers';

export type SignerCustodyMode = 'raw_private_key' | 'kms' | 'mpc';

export interface ManagedSignerOptions {
  url: string;
  custodyMode: 'kms' | 'mpc';
  apiKey?: string;
  requestTimeoutMs?: number;
  requestIdFactory?: () => string;
  recordValidationEvidence?: (record: ManagedSignerValidationAuditRecord) => Promise<void> | void;
}

type ManagedSignerRequestTransaction = Omit<
  ManagedSignerTransactionIntent,
  'requestId' | 'signerAddress'
>;

interface ManagedSignerResponse {
  signerAddress?: unknown;
  signedTransaction?: unknown;
  requestId?: unknown;
  intentHash?: unknown;
}

// The oracle signs settlement attestations only; the managed signer service owns
// the key material (HSM/KMS/MPC) and exposes an oracle-scoped signing endpoint.
const SIGNER_NAME = 'oracle';
const OPERATION = 'oracle_settlement';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function serializeTransaction(tx: ethers.TransactionRequest): ManagedSignerRequestTransaction {
  const type =
    tx.type === null || tx.type === undefined
      ? tx.maxFeePerGas !== null && tx.maxFeePerGas !== undefined
        ? 2
        : 0
      : Number(tx.type);
  if (type !== 0 && type !== 2) {
    throw new Error('Managed signer only permits legacy or EIP-1559 transactions');
  }
  return {
    chainId: Number(tx.chainId),
    to: String(tx.to),
    data: typeof tx.data === 'string' ? tx.data : '0x',
    value: tx.value === undefined || tx.value === null ? '0' : BigInt(tx.value).toString(),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gasLimit ?? 0n).toString(),
    type,
    ...(tx.maxFeePerGas !== undefined && tx.maxFeePerGas !== null
      ? { maxFeePerGasWei: BigInt(tx.maxFeePerGas).toString() }
      : {}),
    ...(tx.maxPriorityFeePerGas !== undefined && tx.maxPriorityFeePerGas !== null
      ? { maxPriorityFeePerGasWei: BigInt(tx.maxPriorityFeePerGas).toString() }
      : {}),
    ...(tx.gasPrice !== undefined && tx.gasPrice !== null
      ? { gasPriceWei: BigInt(tx.gasPrice).toString() }
      : {}),
  };
}

/**
 * An ethers signer that delegates key custody to an external managed signer service
 * (KMS/MPC/HSM backed). Only `getAddress` and `signTransaction` touch the service;
 * gas/nonce/fee population and broadcast stay on the connected provider, so the oracle
 * SDK flow is unchanged. No private key ever lives in the oracle process or its env.
 */
export class ManagedSigner extends ethers.AbstractSigner {
  private cachedAddress?: string;
  private readonly signerUrl: string;
  private readonly addressUrl: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly options: ManagedSignerOptions,
    provider: ethers.Provider,
  ) {
    super(provider);
    const base = options.url.replace(/\/+$/, '');
    this.signerUrl = `${base}/api/signers/${SIGNER_NAME}/sign-transaction`;
    this.addressUrl = `${base}/api/signers/${SIGNER_NAME}/address`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.headers = {
      Accept: 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    };
  }

  connect(provider: ethers.Provider): ManagedSigner {
    return new ManagedSigner(this.options, provider);
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) {
      return this.cachedAddress;
    }

    const response = await fetch(this.addressUrl, {
      method: 'GET',
      headers: this.headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Managed signer address lookup failed (status ${response.status})`);
    }

    const payload = (await response.json()) as { signerAddress?: unknown };
    if (!ethers.isAddress(String(payload.signerAddress))) {
      throw new Error('Managed signer returned an invalid address');
    }

    this.cachedAddress = ethers.getAddress(String(payload.signerAddress));
    return this.cachedAddress;
  }

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const signerAddress = await this.getAddress();
    const requestTransaction = serializeTransaction(tx);
    const requestId = this.requestIdFactory();
    const intent: ManagedSignerTransactionIntent = {
      requestId,
      signerAddress,
      ...requestTransaction,
    };
    const intentHash = buildManagedSignerIntentHash(intent);
    const body = {
      custodyMode: this.options.custodyMode,
      operation: OPERATION,
      requestId,
      intentHash,
      signerAddress,
      transaction: requestTransaction,
    };

    const response = await fetch(this.signerUrl, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Managed signer rejected transaction signing request (status ${response.status})`,
      );
    }

    const payload = (await response.json()) as ManagedSignerResponse;
    try {
      const evidence = validateManagedSignerResponse(payload, intent);
      await this.options.recordValidationEvidence?.({
        ...evidence,
        outcome: 'accepted',
      });
    } catch (error) {
      if (error instanceof ManagedSignerValidationError) {
        await this.options.recordValidationEvidence?.({
          requestId: error.requestId,
          intentHash: error.intentHash,
          ...(error.signedTransactionHash
            ? { signedTransactionHash: error.signedTransactionHash }
            : {}),
          signerAddress,
          nonce: requestTransaction.nonce,
          transactionType: requestTransaction.type,
          outcome: 'rejected',
          failureReason: error.reason,
        });
      }
      throw error;
    }

    return payload.signedTransaction as string;
  }

  // The oracle settlement flow only ever signs transactions: the SDK entry points
  // (`releaseFundsStage1`, `confirmInspectionAvailable`, `finalizeAfterDisputeWindow`) all route
  // through `contract.connect(signer).<method>()`, i.e. `signTransaction`, and never
  // `signMessage`/`signTypedData`. These throw so any future off-path signing surfaces
  // here immediately rather than silently at settlement time in kms/mpc mode.
  async signMessage(): Promise<string> {
    throw new Error('Managed signer does not support message signing for the oracle');
  }

  async signTypedData(): Promise<string> {
    throw new Error('Managed signer does not support typed-data signing for the oracle');
  }
}

import { ethers } from 'ethers';

export type SignerCustodyMode = 'raw_private_key' | 'kms' | 'mpc';

export interface ManagedSignerOptions {
  url: string;
  custodyMode: 'kms' | 'mpc';
  apiKey?: string;
  requestTimeoutMs?: number;
}

interface ManagedSignerRequestTransaction {
  chainId: number;
  to: string;
  data: string;
  value: string;
  nonce: number;
  gasLimit: string;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  gasPriceWei?: string;
}

interface ManagedSignerResponse {
  signerAddress?: unknown;
  signedTransaction?: unknown;
}

// The oracle signs settlement attestations only; the managed signer service owns
// the key material (HSM/KMS/MPC) and exposes an oracle-scoped signing endpoint.
const SIGNER_NAME = 'oracle';
const OPERATION = 'oracle_settlement';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function isHexTransaction(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value);
}

// Case-insensitive, checksum-normalized address comparison that never throws on
// malformed input (so a bad value is rejected with a clear error instead of a raw
// ethers parse throw).
function addressMatches(candidate: unknown, expected: string): boolean {
  return (
    typeof candidate === 'string' &&
    ethers.isAddress(candidate) &&
    ethers.getAddress(candidate) === ethers.getAddress(expected)
  );
}

// Defense in depth: never broadcast a signature we cannot tie back to the exact
// transaction we asked to sign. A compromised or MITM'd signer could otherwise
// return a valid signature over a *different* transaction, and we'd happily
// broadcast it. Parse the signed payload, recover the sender, and assert it and
// the core fields match what we sent.
function assertSignedTransactionMatches(
  signedTransaction: string,
  signerAddress: string,
  request: ManagedSignerRequestTransaction,
): void {
  let parsed: ethers.Transaction;
  try {
    parsed = ethers.Transaction.from(signedTransaction);
  } catch {
    throw new Error('Managed signer returned an unparseable signed transaction');
  }

  if (!addressMatches(parsed.from, signerAddress)) {
    throw new Error('Managed signer returned a transaction signed by an unexpected address');
  }

  const recipientMatches = parsed.to !== null && addressMatches(parsed.to, request.to);
  if (
    !recipientMatches ||
    Number(parsed.chainId) !== request.chainId ||
    parsed.nonce !== request.nonce ||
    parsed.value !== BigInt(request.value) ||
    (parsed.data ?? '0x').toLowerCase() !== request.data.toLowerCase()
  ) {
    throw new Error(
      'Managed signer returned a transaction that does not match the signing request',
    );
  }
}

function serializeTransaction(tx: ethers.TransactionRequest): ManagedSignerRequestTransaction {
  return {
    chainId: Number(tx.chainId),
    to: String(tx.to),
    data: typeof tx.data === 'string' ? tx.data : '0x',
    value: tx.value === undefined || tx.value === null ? '0' : BigInt(tx.value).toString(),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gasLimit ?? 0n).toString(),
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

  constructor(
    private readonly options: ManagedSignerOptions,
    provider: ethers.Provider,
  ) {
    super(provider);
    const base = options.url.replace(/\/+$/, '');
    this.signerUrl = `${base}/api/signers/${SIGNER_NAME}/sign-transaction`;
    this.addressUrl = `${base}/api/signers/${SIGNER_NAME}/address`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
    const body = {
      custodyMode: this.options.custodyMode,
      operation: OPERATION,
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
    // Early, cheap check when the service echoes the signer address; malformed or
    // mismatched values are rejected here rather than throwing a raw parse error.
    if (
      payload.signerAddress !== undefined &&
      !addressMatches(payload.signerAddress, signerAddress)
    ) {
      throw new Error('Managed signer returned an unexpected signer address');
    }
    if (!isHexTransaction(payload.signedTransaction)) {
      throw new Error('Managed signer returned an invalid signed transaction');
    }

    assertSignedTransactionMatches(payload.signedTransaction, signerAddress, requestTransaction);

    return payload.signedTransaction;
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

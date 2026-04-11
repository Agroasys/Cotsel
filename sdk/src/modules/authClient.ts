/**
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @deprecated Agroasys production flows should authenticate users through
 * Agroasys auth and pass an Agroasys-managed signer into the SDK. This helper
 * remains only for standalone wallet-challenge demos.
 */
import { web3Wallet } from '../wallet/wallet-provider';

// Types

export type AuthRole = 'buyer' | 'supplier' | 'admin';

export interface AuthClientConfig {
  baseUrl: string;
  expectedChainId?: number;
}

export interface SessionResult {
  sessionId: string;
  walletAddress: string;
  role: AuthRole;
  issuedAt: number;
  expiresAt: number;
}

export interface LoginOptions {
  role: AuthRole;
  /** Optional organisation identifier for buyer/supplier profiles. */
  orgId?: string;
  /** Custom session lifetime in seconds. Defaults to the service default (24 h). */
  ttlSeconds?: number;
}

// Internal helpers

function trimBase(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function apiRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success) {
    throw new Error(body.message || body.error || `Request failed with status ${response.status}`);
  }
  return body.data as T;
}

// AuthClient

export class AuthClient {
  private readonly base: string;
  private readonly expectedChainId: number | null;

  constructor(config: AuthClientConfig) {
    this.base = `${trimBase(config.baseUrl)}/api/auth/v1`;
    this.expectedChainId = config.expectedChainId ?? null;
  }

  private async assertWalletNetwork(signer: {
    provider?: { getNetwork(): Promise<{ chainId: bigint | number | string }> } | null;
  }): Promise<void> {
    if (!this.expectedChainId) {
      return;
    }

    if (!signer.provider || typeof signer.provider.getNetwork !== 'function') {
      throw new Error('Connected wallet signer is missing provider network context.');
    }

    const network = await signer.provider.getNetwork();
    const actualChainId = Number(network.chainId);
    if (actualChainId !== this.expectedChainId) {
      throw new Error(
        `Connected wallet is on the wrong network. Expected chainId=${this.expectedChainId}, received ${actualChainId}.`,
      );
    }
  }

  async login(options: LoginOptions): Promise<SessionResult> {
    await web3Wallet.connect();
    const signer = await web3Wallet.getSigner();
    await this.assertWalletNetwork(signer);
    const walletAddress = (await signer.getAddress()).toLowerCase();

    const challenge = await apiRequest<{ message: string; expiresIn: number }>(
      `${this.base}/challenge?wallet=${encodeURIComponent(walletAddress)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );

    const signature = await signer.signMessage(challenge.message);

    const body: Record<string, unknown> = {
      walletAddress,
      signature,
      role: options.role,
    };
    if (options.orgId !== undefined) {
      body.orgId = options.orgId;
    }
    if (options.ttlSeconds !== undefined) {
      body.ttlSeconds = options.ttlSeconds;
    }

    return apiRequest<SessionResult>(`${this.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async refresh(sessionToken: string): Promise<SessionResult> {
    return apiRequest<SessionResult>(`${this.base}/session/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });
  }

  async revoke(sessionToken: string): Promise<void> {
    await apiRequest<unknown>(`${this.base}/session/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });
  }

  async getSession(sessionToken: string): Promise<SessionResult> {
    return apiRequest<SessionResult>(`${this.base}/session`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
  }
}

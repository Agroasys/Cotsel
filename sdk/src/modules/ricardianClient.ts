/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  RicardianHashEnvelope,
  RicardianHashRecord,
  RicardianHashRequest,
} from '../types/ricardian';

export interface RicardianClientConfig {
  baseUrl: string;
  apiKey?: string;
}

function ensureTrailingBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export class RicardianClient {
  private readonly baseUrl: string;

  constructor(private readonly config: RicardianClientConfig) {
    this.baseUrl = ensureTrailingBase(config.baseUrl);
  }

  private headers(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  async generateHash(payload: RicardianHashRequest): Promise<RicardianHashRecord> {
    const response = await fetch(`${this.baseUrl}/api/ricardian/v1/hash`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as RicardianHashEnvelope;

    if (!response.ok || !body.success || !body.data) {
      throw new Error(body.error || `Ricardian hash generation failed (${response.status})`);
    }

    return body.data;
  }

  async getHash(hash: string): Promise<RicardianHashRecord> {
    const response = await fetch(`${this.baseUrl}/api/ricardian/v1/hash/${hash}`, {
      method: 'GET',
      headers: this.headers(),
    });

    const body = (await response.json()) as RicardianHashEnvelope;

    if (!response.ok || !body.success || !body.data) {
      throw new Error(body.error || `Ricardian hash fetch failed (${response.status})`);
    }

    return body.data;
  }
}

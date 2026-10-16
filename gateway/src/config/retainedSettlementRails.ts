/** SPDX-License-Identifier: Apache-2.0 */
import { getAddress } from 'ethers';
import type { ProjectionCoverageConfig } from '../core/settlementProjectionCoverage';

export type ObservedSettlementRail = ProjectionCoverageConfig & {
  rpcUrl: string;
  rpcFallbackUrls: string[];
};
export type RetainedSettlementRail = ObservedSettlementRail & {
  railManifestSha256: string;
  executionOracleBaseUrl?: string;
};

/** Observation-only registry. New issuance continues to use the active deployment configuration. */
export function parseRetainedSettlementRails(raw: string | undefined): RetainedSettlementRail[] {
  if (!raw?.trim()) return [];
  try {
    if (raw.length > 65536) throw new Error();
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 8) throw new Error();
    const identities = new Set<string>();
    return values.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const row = value as Record<string, unknown>;
      const keys = [
        'chainId',
        'escrowAddress',
        'usdcAddress',
        'rpcUrl',
        'rpcFallbackUrls',
        'indexerCoverageUrl',
        'reconciliationCoverageUrl',
        'railManifestSha256',
      ];
      if (
        Object.keys(row).some((key) => ![...keys, 'executionOracleBaseUrl'].includes(key)) ||
        keys.some((key) => !(key in row))
      )
        throw new Error();
      if (
        !Number.isSafeInteger(row.chainId) ||
        Number(row.chainId) <= 0 ||
        typeof row.escrowAddress !== 'string' ||
        typeof row.usdcAddress !== 'string' ||
        typeof row.railManifestSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.railManifestSha256)
      )
        throw new Error();
      const escrowAddress = getAddress(row.escrowAddress).toLowerCase();
      const usdcAddress = getAddress(row.usdcAddress).toLowerCase();
      const identity = `${row.chainId}:${escrowAddress}`;
      if (identities.has(identity)) throw new Error();
      identities.add(identity);
      const url = (input: unknown): string => {
        if (typeof input !== 'string' || input.length > 2048) throw new Error();
        const parsed = new URL(input);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
          throw new Error();
        return parsed.toString();
      };
      const rpcUrl = url(row.rpcUrl);
      if (
        !Array.isArray(row.rpcFallbackUrls) ||
        row.rpcFallbackUrls.length < 1 ||
        row.rpcFallbackUrls.length > 4
      )
        throw new Error();
      const rpcFallbackUrls = row.rpcFallbackUrls.map(url);
      if (new Set([rpcUrl, ...rpcFallbackUrls].map((value) => new URL(value).hostname)).size < 2)
        throw new Error();
      return {
        chainId: Number(row.chainId),
        escrowAddress,
        usdcAddress,
        rpcUrl,
        rpcFallbackUrls,
        indexerCoverageUrl: url(row.indexerCoverageUrl),
        reconciliationCoverageUrl: url(row.reconciliationCoverageUrl),
        railManifestSha256: row.railManifestSha256,
        ...(row.executionOracleBaseUrl === null || row.executionOracleBaseUrl === undefined
          ? {}
          : { executionOracleBaseUrl: url(row.executionOracleBaseUrl) }),
      };
    });
  } catch {
    throw new Error(
      'GATEWAY_RETAINED_SETTLEMENT_RAILS_JSON requires approved distinct deployments, retained coverage services and independent HTTPS witnesses',
    );
  }
}

export function selectObservedSettlementRail(
  config: ObservedSettlementRail & { retainedSettlementRails?: RetainedSettlementRail[] },
  chainId: number,
  destination: string,
): ObservedSettlementRail | null {
  return (
    [config, ...(config.retainedSettlementRails ?? [])].find(
      (rail) =>
        rail.chainId === chainId &&
        [rail.escrowAddress, rail.usdcAddress].some(
          (address) => address.toLowerCase() === destination.toLowerCase(),
        ),
    ) ?? null
  );
}

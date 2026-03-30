/**
 * SPDX-License-Identifier: Apache-2.0
 */
export const BASE_SETTLEMENT_RUNTIME_KEYS = ['base-sepolia', 'base-mainnet'] as const;

export type BaseSettlementRuntimeKey = typeof BASE_SETTLEMENT_RUNTIME_KEYS[number];
export type SettlementRuntimeKey = BaseSettlementRuntimeKey | 'custom';

export interface BaseSettlementRuntimeDefinition {
  key: BaseSettlementRuntimeKey;
  networkName: string;
  chainId: number;
  explorerBaseUrl: string;
  rpcUrl: string;
  rpcFallbackUrls: string[];
  usdcAddress: string;
}

export interface ResolveSettlementRuntimeInput {
  runtimeKey?: string | null;
  rpcUrl?: string | null;
  rpcFallbackUrls?: string[] | null;
  chainId?: number | null;
  explorerBaseUrl?: string | null;
  escrowAddress?: string | null;
  usdcAddress?: string | null;
}

export interface ResolvedSettlementRuntime {
  runtimeKey: SettlementRuntimeKey;
  networkName: string;
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrls: string[];
  explorerBaseUrl: string | null;
  escrowAddress: string | null;
  usdcAddress: string | null;
}

const BASE_SETTLEMENT_RUNTIMES: Record<BaseSettlementRuntimeKey, BaseSettlementRuntimeDefinition> = {
  'base-sepolia': {
    key: 'base-sepolia',
    networkName: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    rpcFallbackUrls: [],
    explorerBaseUrl: 'https://sepolia-explorer.base.org/tx/',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  'base-mainnet': {
    key: 'base-mainnet',
    networkName: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    rpcFallbackUrls: [],
    explorerBaseUrl: 'https://base.blockscout.com/tx/',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
};

function normalizeOptionalUrl(value?: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/+$/, '');
}

function normalizeOptionalTxExplorerBase(value?: string | null): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) {
    return null;
  }

  return normalized.endsWith('/tx') || normalized.endsWith('/tx/')
    ? `${normalized.replace(/\/+$/, '')}/`
    : `${normalized}/tx/`;
}

function normalizeUrlList(values?: string[] | null): string[] {
  if (!values?.length) {
    return [];
  }

  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeOptionalUrl(value);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

function isBaseRuntimeKey(value: string): value is BaseSettlementRuntimeKey {
  return (BASE_SETTLEMENT_RUNTIME_KEYS as readonly string[]).includes(value);
}

function findBaseRuntimeByChainId(chainId?: number | null): BaseSettlementRuntimeDefinition | null {
  if (!chainId) {
    return null;
  }

  return Object.values(BASE_SETTLEMENT_RUNTIMES).find((runtime) => runtime.chainId === chainId) ?? null;
}

export function getBaseSettlementRuntime(key: BaseSettlementRuntimeKey): BaseSettlementRuntimeDefinition {
  return BASE_SETTLEMENT_RUNTIMES[key];
}

export function listBaseSettlementRuntimes(): BaseSettlementRuntimeDefinition[] {
  return [...Object.values(BASE_SETTLEMENT_RUNTIMES)];
}

export function buildExplorerTxUrl(
  explorerBaseUrl: string | null | undefined,
  txHash: string | null | undefined,
): string | null {
  const baseUrl = normalizeOptionalTxExplorerBase(explorerBaseUrl);
  const normalizedTxHash = txHash?.trim() || null;
  if (!baseUrl || !normalizedTxHash) {
    return null;
  }

  return `${baseUrl}${normalizedTxHash}`;
}

export function resolveSettlementRuntime(input: ResolveSettlementRuntimeInput): ResolvedSettlementRuntime {
  const explicitRuntimeKey = input.runtimeKey?.trim().toLowerCase() || null;
  const normalizedRpcUrl = normalizeOptionalUrl(input.rpcUrl);
  const normalizedFallbackUrls = normalizeUrlList(input.rpcFallbackUrls);
  const normalizedExplorerBaseUrl = normalizeOptionalTxExplorerBase(input.explorerBaseUrl);
  const normalizedEscrowAddress = input.escrowAddress?.trim() || null;
  const normalizedUsdcAddress = input.usdcAddress?.trim() || null;

  let baseRuntime: BaseSettlementRuntimeDefinition | null = null;
  if (explicitRuntimeKey) {
    if (!isBaseRuntimeKey(explicitRuntimeKey)) {
      throw new Error(
        `Unknown settlement runtime "${explicitRuntimeKey}". Expected one of: ${BASE_SETTLEMENT_RUNTIME_KEYS.join(', ')}`,
      );
    }

    baseRuntime = getBaseSettlementRuntime(explicitRuntimeKey);
  } else {
    baseRuntime = findBaseRuntimeByChainId(input.chainId ?? null);
  }

  if (baseRuntime) {
    const chainId = input.chainId ?? baseRuntime.chainId;
    if (chainId !== baseRuntime.chainId) {
      throw new Error(
        `Settlement runtime ${baseRuntime.key} requires chainId=${baseRuntime.chainId}, received ${chainId}`,
      );
    }

    return {
      runtimeKey: baseRuntime.key,
      networkName: baseRuntime.networkName,
      chainId: baseRuntime.chainId,
      rpcUrl: normalizedRpcUrl ?? baseRuntime.rpcUrl,
      rpcFallbackUrls: normalizedFallbackUrls.length > 0 ? normalizedFallbackUrls : baseRuntime.rpcFallbackUrls,
      explorerBaseUrl: normalizedExplorerBaseUrl ?? baseRuntime.explorerBaseUrl,
      escrowAddress: normalizedEscrowAddress,
      usdcAddress: normalizedUsdcAddress ?? baseRuntime.usdcAddress,
    };
  }

  if (!normalizedRpcUrl || !input.chainId) {
    throw new Error(
      'Custom settlement runtime requires explicit rpcUrl and chainId when runtimeKey is not a known Base runtime',
    );
  }

  return {
    runtimeKey: 'custom',
    networkName: `Custom (${input.chainId})`,
    chainId: input.chainId,
    rpcUrl: normalizedRpcUrl,
    rpcFallbackUrls: normalizedFallbackUrls,
    explorerBaseUrl: normalizedExplorerBaseUrl,
    escrowAddress: normalizedEscrowAddress,
    usdcAddress: normalizedUsdcAddress,
  };
}

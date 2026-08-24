/**
 * Minimal RPC reachability probe for the indexer.
 *
 * The indexer is a standalone Subsquid app (separate stack from the ethers
 * services), so this duplicates the tiny probe rather than pulling in the whole
 * @agroasys/sdk runtime. Subsquid's EvmBatchProcessor takes a single RPC URL,
 * so rotation happens at startup: pick the first reachable endpoint from the
 * configured priority list.
 */
const DEFAULT_RPC_TIMEOUT_MS = 3000;

interface JsonRpcResponse {
  jsonrpc?: string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

class RpcChainIdMismatchError extends Error {
  constructor(expectedChainId: number, actualChainId: bigint) {
    super(`Wrong chain: expected ${expectedChainId}, received ${actualChainId.toString()}`);
    this.name = 'RpcChainIdMismatchError';
  }
}

export function redactRpcUrlForLogs(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '[invalid-rpc-url]';
  }
}

async function callRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload?.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC response');
    }

    if (payload.error) {
      throw new Error(
        `RPC error ${payload.error.code ?? 'UNKNOWN'}: ${payload.error.message ?? 'Unknown error'}`,
      );
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
      throw new Error('Missing JSON-RPC result');
    }

    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertRpcEndpointReachable(
  rpcUrl: string,
  expectedChainId: number,
  timeoutMs: number,
): Promise<void> {
  const chainIdResult = await callRpc(rpcUrl, 'eth_chainId', [], timeoutMs);
  if (typeof chainIdResult !== 'string') {
    throw new Error('Invalid eth_chainId result');
  }

  let actualChainId: bigint;
  try {
    actualChainId = BigInt(chainIdResult);
  } catch {
    throw new Error('Invalid eth_chainId result');
  }

  if (actualChainId !== BigInt(expectedChainId)) {
    throw new RpcChainIdMismatchError(expectedChainId, actualChainId);
  }

  const blockNumberResult = await callRpc(rpcUrl, 'eth_blockNumber', [], timeoutMs);
  if (typeof blockNumberResult !== 'string') {
    throw new Error('Invalid eth_blockNumber result');
  }

  let head: bigint;
  try {
    head = BigInt(blockNumberResult);
  } catch {
    throw new Error('Invalid eth_blockNumber result');
  }

  const probeHeight = head > 0n ? head - 1n : head;
  const probeBlockNumber = `0x${probeHeight.toString(16)}`;
  const blockResult = await callRpc(
    rpcUrl,
    'eth_getBlockByNumber',
    [probeBlockNumber, false],
    timeoutMs,
  );

  if (!blockResult || typeof blockResult !== 'object') {
    throw new Error('Invalid eth_getBlockByNumber result');
  }

  const returnedNumber = (blockResult as { number?: unknown }).number;
  if (typeof returnedNumber !== 'string' || BigInt(returnedNumber) !== probeHeight) {
    throw new Error('eth_getBlockByNumber returned an unexpected block');
  }
}

export interface ReachableRpcEndpointSelection {
  url: string;
  reachable: boolean;
  checked: number;
  selectedIndex: number;
}

/**
 * Pick the first endpoint from an ordered priority list that returns the
 * expected chain ID and serves a representative block. Validate every
 * configured endpoint before selecting the first valid one so a wrong-chain
 * fallback cannot be hidden by a healthy primary. Fail closed when none passes
 * validation.
 */
export async function selectReachableRpcEndpoint(
  rpcUrls: string[],
  expectedChainId: number,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<ReachableRpcEndpointSelection> {
  if (rpcUrls.length === 0) {
    throw new Error('selectReachableRpcEndpoint requires at least one RPC endpoint');
  }

  let selected: ReachableRpcEndpointSelection | null = null;
  let checked = 0;
  const failures: string[] = [];

  for (const [index, url] of rpcUrls.entries()) {
    checked += 1;
    try {
      await assertRpcEndpointReachable(url, expectedChainId, timeoutMs);
      selected ??= { url, reachable: true, checked, selectedIndex: index };
    } catch (error) {
      if (error instanceof RpcChainIdMismatchError) {
        throw error;
      }

      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (selected) {
    return { ...selected, checked };
  }

  throw new Error(
    `No configured RPC endpoint passed chain and block validation for chain ${expectedChainId}. ${failures[0]}`,
  );
}

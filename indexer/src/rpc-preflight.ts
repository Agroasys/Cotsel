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

async function isRpcEndpointReachable(
  rpcUrl: string,
  expectedChainId: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const chainIdResult = await callRpc(rpcUrl, 'eth_chainId', [], timeoutMs);
    if (typeof chainIdResult !== 'string' || BigInt(chainIdResult) !== BigInt(expectedChainId)) {
      return false;
    }

    const blockNumberResult = await callRpc(rpcUrl, 'eth_blockNumber', [], timeoutMs);
    if (typeof blockNumberResult !== 'string') {
      return false;
    }

    const head = BigInt(blockNumberResult);
    const probeHeight = head > 0n ? head - 1n : head;
    const probeBlockNumber = `0x${probeHeight.toString(16)}`;
    const blockResult = await callRpc(
      rpcUrl,
      'eth_getBlockByNumber',
      [probeBlockNumber, false],
      timeoutMs,
    );

    if (!blockResult || typeof blockResult !== 'object') {
      return false;
    }

    const returnedNumber = (blockResult as { number?: unknown }).number;
    return typeof returnedNumber === 'string' && BigInt(returnedNumber) === probeHeight;
  } catch {
    return false;
  }
}

export interface ReachableRpcEndpointSelection {
  url: string;
  reachable: boolean;
  checked: number;
}

/**
 * Pick the first endpoint from an ordered priority list that returns the
 * expected chain ID and serves a representative block. Fail closed when none
 * passes validation.
 */
export async function selectReachableRpcEndpoint(
  rpcUrls: string[],
  expectedChainId: number,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<ReachableRpcEndpointSelection> {
  if (rpcUrls.length === 0) {
    throw new Error('selectReachableRpcEndpoint requires at least one RPC endpoint');
  }

  let checked = 0;
  for (const url of rpcUrls) {
    checked += 1;
    if (await isRpcEndpointReachable(url, expectedChainId, timeoutMs)) {
      return { url, reachable: true, checked };
    }
  }

  throw new Error(
    `No configured RPC endpoint returned expected chain ID ${expectedChainId} after ${checked} checks`,
  );
}

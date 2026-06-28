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

export function redactRpcUrlForLogs(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '[invalid-rpc-url]';
  }
}

async function isRpcEndpointReachable(rpcUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { jsonrpc?: string; result?: string };
    return payload?.jsonrpc === '2.0' && typeof payload.result === 'string';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ReachableRpcEndpointSelection {
  url: string;
  reachable: boolean;
  checked: number;
}

/**
 * Pick the first reachable endpoint from an ordered (priority) list. Never
 * throws: if none answer it returns the primary so Subsquid's own retry can
 * recover rather than crash-looping the indexer.
 */
export async function selectReachableRpcEndpoint(
  rpcUrls: string[],
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<ReachableRpcEndpointSelection> {
  if (rpcUrls.length === 0) {
    throw new Error('selectReachableRpcEndpoint requires at least one RPC endpoint');
  }

  let checked = 0;
  for (const url of rpcUrls) {
    checked += 1;
    if (await isRpcEndpointReachable(url, timeoutMs)) {
      return { url, reachable: true, checked };
    }
  }

  return { url: rpcUrls[0], reachable: false, checked };
}

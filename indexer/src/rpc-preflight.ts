import { setTimeout as delay } from 'node:timers/promises';

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

export class RpcUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RpcUnavailableError';
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
}

export async function callRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  // Retries and server-directed delays share the original call's timeout budget.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let response: Response;
        try {
          response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: controller.signal,
          });
        } catch {
          throw new RpcUnavailableError('RPC transport unavailable');
        }
        if ([429, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          throw new RpcUnavailableError(
            `HTTP ${response.status}`,
            retryAfterMs(response.headers.get('retry-after')),
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        let payload: JsonRpcResponse;
        try {
          payload = (await response.json()) as JsonRpcResponse;
        } catch (error) {
          if (error instanceof SyntaxError) throw error;
          throw new RpcUnavailableError('RPC response transport unavailable');
        }
        if (payload?.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC response');
        if (payload.error?.code === -32005)
          throw new RpcUnavailableError('RPC rate limit exceeded');
        if (payload.error) {
          throw new Error(
            `RPC error ${payload.error.code ?? 'UNKNOWN'}: ${payload.error.message ?? 'Unknown error'}`,
          );
        }
        if (!Object.prototype.hasOwnProperty.call(payload, 'result'))
          throw new Error('Missing JSON-RPC result');
        return payload.result;
      } catch (error) {
        if (controller.signal.aborted) throw new RpcUnavailableError('RPC request timed out');
        if (!(error instanceof RpcUnavailableError) || attempt === 2) throw error;
        try {
          await delay(Math.min(error.retryAfterMs ?? 500 * 2 ** attempt, timeoutMs), undefined, {
            signal: controller.signal,
          });
        } catch {
          throw new RpcUnavailableError('RPC request timed out');
        }
      }
    }
    throw new RpcUnavailableError('RPC retry budget exhausted');
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
  validateEndpoint?: (url: string) => Promise<void>,
): Promise<ReachableRpcEndpointSelection> {
  if (rpcUrls.length === 0) {
    throw new Error('selectReachableRpcEndpoint requires at least one RPC endpoint');
  }

  const reachable: ReachableRpcEndpointSelection[] = [];
  let checked = 0;
  const failures: string[] = [];

  for (const [index, url] of rpcUrls.entries()) {
    checked += 1;
    try {
      await assertRpcEndpointReachable(url, expectedChainId, timeoutMs);
      reachable.push({ url, reachable: true, checked, selectedIndex: index });
    } catch (error) {
      if (error instanceof RpcChainIdMismatchError) {
        throw error;
      }

      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Check all chain identities before full verification. Transport failures may
  // select another endpoint; contract, finality, checkpoint and quarantine drift may not.
  for (const candidate of reachable) {
    try {
      await validateEndpoint?.(candidate.url);
      return { ...candidate, checked };
    } catch (error) {
      if (!(error instanceof RpcUnavailableError)) throw error;
      failures.push(error.message);
    }
  }

  throw new Error(
    `No configured RPC endpoint passed startup validation for chain ${expectedChainId}. ${failures[0]}`,
  );
}

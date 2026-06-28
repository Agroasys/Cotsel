/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared RPC reachability checks used at service startup.
 *
 * Goal: a service must not crash because its *primary* RPC is down when a
 * fallback is healthy. These helpers probe endpoints with `eth_chainId` and
 * treat the configured set as reachable when at least one endpoint answers.
 */
const DEFAULT_RPC_TIMEOUT_MS = 3000;

interface JsonRpcSuccess {
  jsonrpc: string;
  result?: string;
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

function sanitizeReason(reason: string, rpcUrl: string): string {
  const redactedRpcUrl = redactRpcUrlForLogs(rpcUrl);
  return reason
    .split(rpcUrl)
    .join(redactedRpcUrl)
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]');
}

function formatRpcFailureMessage(rpcUrl: string, reason: string): string {
  const redactedRpcUrl = redactRpcUrlForLogs(rpcUrl);
  const safeReason = sanitizeReason(reason, rpcUrl);
  return `RPC endpoint is not reachable at startup (RPC_URL=${redactedRpcUrl}). Start a JSON-RPC node or update RPC_URL. Reason: ${safeReason}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function assertRpcEndpointReachable(
  rpcUrl: string,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let payload: JsonRpcSuccess | null = null;

    try {
      payload = (await response.json()) as JsonRpcSuccess;
    } catch {
      throw new Error('Invalid JSON response');
    }

    if (!payload || payload.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC payload');
    }

    if (payload.error) {
      throw new Error(
        `RPC error ${payload.error.code ?? 'UNKNOWN'}: ${payload.error.message ?? 'Unknown error'}`,
      );
    }

    if (!payload.result) {
      throw new Error('Missing eth_chainId result');
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(formatRpcFailureMessage(rpcUrl, `Timeout after ${timeoutMs}ms`));
    }

    throw new Error(formatRpcFailureMessage(rpcUrl, getErrorMessage(error)));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pass when at least one configured endpoint answers. Throws only when every
 * endpoint fails — a single dead endpoint never blocks startup. Emits a warning
 * (never throws) when no fallback is configured, since that silently disables
 * RPC rotation.
 */
export async function assertRpcEndpointsReachable(
  rpcUrls: string[],
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<void> {
  if (rpcUrls.length === 1) {
    console.warn(
      `Only one RPC endpoint configured (${redactRpcUrlForLogs(
        rpcUrls[0],
      )}); RPC failover is disabled. Configure fallback endpoints for rotation.`,
    );
  }

  const failures: string[] = [];

  for (const rpcUrl of rpcUrls) {
    try {
      await assertRpcEndpointReachable(rpcUrl, timeoutMs);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (rpcUrls.length > 0 && failures.length === rpcUrls.length) {
    throw new Error(`All configured RPC endpoints failed startup validation. ${failures[0]}`);
  }
}

export interface ReachableRpcEndpointSelection {
  /** The endpoint to use: the first reachable one, else the first configured one. */
  url: string;
  /** Whether the selected endpoint actually answered the probe. */
  reachable: boolean;
  /** Number of endpoints probed before a reachable one was found (or all). */
  checked: number;
}

/**
 * Pick the first reachable endpoint from an ordered (priority) list. Used by
 * consumers that take a single endpoint (e.g. the Subsquid indexer) and cannot
 * use ethers FallbackProvider. Never throws: if none answer it returns the
 * primary so the caller's own retry/recovery can take over rather than
 * crash-looping.
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
    try {
      await assertRpcEndpointReachable(url, timeoutMs);
      return { url, reachable: true, checked };
    } catch {
      // try the next endpoint in priority order
    }
  }

  return { url: rpcUrls[0], reachable: false, checked };
}

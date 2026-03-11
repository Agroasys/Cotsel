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
      throw new Error(`RPC error ${payload.error.code ?? 'UNKNOWN'}: ${payload.error.message ?? 'Unknown error'}`);
    }

    if (!payload.result) {
      throw new Error('Missing eth_chainId result');
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(formatRpcFailureMessage(rpcUrl, `Timeout after ${timeoutMs}ms`));
    }

    throw new Error(formatRpcFailureMessage(rpcUrl, error?.message || 'Unknown RPC connection error'));
  } finally {
    clearTimeout(timeout);
  }
}

export async function assertRpcEndpointsReachable(
  rpcUrls: string[],
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<void> {
  const failures: string[] = [];

  for (const rpcUrl of rpcUrls) {
    try {
      await assertRpcEndpointReachable(rpcUrl, timeoutMs);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length === rpcUrls.length) {
    throw new Error(`All configured RPC endpoints failed startup validation. ${failures[0]}`);
  }
}

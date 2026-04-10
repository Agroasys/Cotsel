export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export class IndexerNetworkError extends Error {
  constructor(url: string, message: string) {
    super(`Network request to ${url} failed: ${message}`);
    this.name = 'IndexerNetworkError';
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchTimeoutError(url, timeoutMs);
    }

    if (error instanceof Error) {
      throw new IndexerNetworkError(url, error.message);
    }

    throw new IndexerNetworkError(url, String(error));
  } finally {
    clearTimeout(timeoutHandle);
  }
}

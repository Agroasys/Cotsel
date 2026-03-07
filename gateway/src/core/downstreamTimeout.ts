/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError, GatewayErrorCode } from '../errors';

interface TimeoutOptions {
  statusCode?: number;
  code?: GatewayErrorCode;
  details?: Record<string, unknown>;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  options: TimeoutOptions = {},
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new GatewayError(
            options.statusCode ?? 503,
            options.code ?? 'UPSTREAM_UNAVAILABLE',
            message,
            {
              timeoutMs,
              cause: 'timeout',
              ...(options.details ?? {}),
            },
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

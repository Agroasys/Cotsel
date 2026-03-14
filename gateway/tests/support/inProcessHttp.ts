/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Express } from 'express';
import { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { Duplex } from 'stream';

class MockSocket extends Duplex {
  readonly output: Buffer[] = [];
  remoteAddress = '127.0.0.1';
  encrypted = false;

  _read(): void {}

  _write(
    chunk: string | Buffer | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (Buffer.isBuffer(chunk)) {
      this.output.push(chunk);
    } else if (typeof chunk === 'string') {
      this.output.push(Buffer.from(chunk, encoding));
    } else {
      this.output.push(Buffer.from(chunk));
    }
    callback();
  }

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  destroy(): this {
    return this;
  }

  cork(): void {}

  uncork(): void {}
}

export interface InProcessRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface InProcessResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json<T>(): T;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function extractBody(rawResponse: Buffer): string {
  const separator = rawResponse.indexOf('\r\n\r\n');
  if (separator === -1) {
    return '';
  }

  return rawResponse.subarray(separator + 4).toString('utf8');
}

export async function sendInProcessRequest(
  app: Express,
  options: InProcessRequestOptions,
): Promise<InProcessResponse> {
  const bodyBuffer = options.body ? Buffer.from(options.body, 'utf8') : null;
  const requestHeaders = normalizeHeaders({
    ...(options.headers ?? {}),
    ...(bodyBuffer ? { 'content-length': String(bodyBuffer.length) } : {}),
  });

  const requestSocket = new MockSocket();
  const request = new IncomingMessage(requestSocket as unknown as Socket);
  request.method = options.method;
  request.url = options.path;
  request.headers = requestHeaders;
  request.httpVersion = '1.1';
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;

  const responseSocket = new MockSocket();
  const response = new ServerResponse(request);
  response.assignSocket(responseSocket as unknown as Socket);

  return await new Promise<InProcessResponse>((resolve, reject) => {
    response.once('error', reject);
    response.once('finish', () => {
      const text = extractBody(Buffer.concat(responseSocket.output));

      resolve({
        status: response.statusCode,
        headers: Object.fromEntries(
          Object.entries(response.getHeaders()).map(([key, value]) => [key.toLowerCase(), String(value)]),
        ),
        text,
        json<T>() {
          return JSON.parse(text) as T;
        },
      });
    });

    (app as unknown as {
      handle(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void;
    }).handle(request, response, (error: unknown) => {
      if (error) {
        reject(error);
      }
    });

    if (bodyBuffer) {
      request.push(bodyBuffer);
    }

    request.push(null);
  });
}

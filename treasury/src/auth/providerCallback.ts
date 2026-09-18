/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ProviderCallbackAuthError,
  verifyProviderCallback,
  type ProviderCallbackVerification,
  type ProviderWebhookSecret,
} from '../core/providerCallbackAuth';

export type ProviderCallbackRequest = Request & {
  rawBody?: Buffer;
  providerCallback?: ProviderCallbackVerification;
};

export interface ProviderCallbackMiddlewareOptions {
  enabled: boolean;
  secrets: ProviderWebhookSecret[];
  maxSkewSeconds: number;
  resolvePartnerCode: (req: Request) => string | undefined;
  resolveBodyEventId: (req: Request) => string | undefined;
  nowSeconds?: () => number;
  onReject?: (code: string) => void;
}

/**
 * Replay is contained by two layers that outlive this middleware: the signed
 * timestamp bounds how long a captured callback stays usable, and the durable
 * `provider_event_id` uniqueness makes a re-delivered event resolve to the
 * record it already wrote. A consumed one-shot nonce would reject the
 * provider's own at-least-once retries, so it is deliberately not used here.
 */
export function createProviderCallbackMiddleware(
  options: ProviderCallbackMiddlewareOptions,
): RequestHandler {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const onReject = options.onReject ?? (() => undefined);

  return (req: ProviderCallbackRequest, res: Response, next: NextFunction) => {
    if (!options.enabled) {
      next();
      return;
    }

    try {
      req.providerCallback = verifyProviderCallback({
        partnerCode: options.resolvePartnerCode(req) ?? '',
        signatureHeader: req.header('x-webhook-signature') ?? undefined,
        headerEventId: req.header('x-webhook-event-id') ?? undefined,
        bodyEventId: options.resolveBodyEventId(req),
        rawBody: req.rawBody ?? Buffer.alloc(0),
        secrets: options.secrets,
        nowSeconds: nowSeconds(),
        maxSkewSeconds: options.maxSkewSeconds,
      });
    } catch (error) {
      if (error instanceof ProviderCallbackAuthError) {
        onReject(error.code);
        res.status(401).json({ success: false, code: error.code, error: error.message });
        return;
      }

      throw error;
    }

    next();
  };
}

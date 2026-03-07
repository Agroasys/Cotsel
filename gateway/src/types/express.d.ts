/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import type { IdempotencyRequestState } from '../middleware/idempotency';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      requestContext?: RequestContext;
      gatewayPrincipal?: GatewayPrincipal;
      idempotencyState?: IdempotencyRequestState;
    }
  }
}

export {};

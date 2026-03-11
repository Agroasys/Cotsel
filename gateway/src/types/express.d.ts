/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import type { IdempotencyRequestState } from '../middleware/idempotency';
import type { ServiceAuthContext } from '@agroasys/shared-auth/serviceAuth';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      requestContext?: RequestContext;
      gatewayPrincipal?: GatewayPrincipal;
      idempotencyState?: IdempotencyRequestState;
      serviceAuth?: ServiceAuthContext;
    }
  }
}

export {};

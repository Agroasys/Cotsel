/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import type { IdempotencyRequestState } from '../middleware/idempotency';
import type { ServiceAuthContext } from '@agroasys/shared-auth/serviceAuth';
import type { StepUpEvidence } from '../core/stepUpAudit';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      requestContext?: RequestContext;
      gatewayPrincipal?: GatewayPrincipal;
      idempotencyState?: IdempotencyRequestState;
      serviceAuth?: ServiceAuthContext;
      /** Set by requireRecentStepUp for a privileged mutation (Cotsel#946). */
      stepUpEvidence?: StepUpEvidence;
    }
  }
}

export {};

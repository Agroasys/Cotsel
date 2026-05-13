/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ServiceAuthContext } from '@agroasys/shared-auth/serviceAuth';
import type { UserSession } from '../types';

declare global {
  namespace Express {
    interface Request {
      userSession?: UserSession;
      serviceAuth?: ServiceAuthContext;
    }
  }
}

export {};

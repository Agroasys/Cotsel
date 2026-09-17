import type { ServiceAuthContext } from '@agroasys/shared-auth/serviceAuth';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      serviceAuth?: ServiceAuthContext;
    }
  }
}

export {};

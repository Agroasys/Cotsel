/**
 * SPDX-License-Identifier: Apache-2.0
 */
import cors from 'cors';
import express, { RequestHandler, Router } from 'express';
import helmet from 'helmet';
import { createCorsOptions } from '@agroasys/shared-edge';
import { GatewayConfig } from './config/env';
import { createRequestContextMiddleware } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createSystemRouter, DependencyStatus } from './routes/system';

export interface GatewayAppDependencies {
  version: string;
  commitSha: string;
  buildTime: string;
  readinessCheck: () => Promise<DependencyStatus[]>;
  requestRateLimitMiddleware?: RequestHandler;
  extraRouter?: Router;
}

export function createApp(config: GatewayConfig, dependencies: GatewayAppDependencies) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors(
      createCorsOptions({
        allowedOrigins: config.corsAllowedOrigins,
        allowNoOrigin: config.corsAllowNoOrigin,
      }),
    ),
  );
  app.use(createRequestContextMiddleware());
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request).rawBody = Buffer.from(buffer);
      },
    }),
  );

  if (dependencies.requestRateLimitMiddleware) {
    app.use('/api/dashboard-gateway/v1', dependencies.requestRateLimitMiddleware);
  }

  app.use(
    '/api/dashboard-gateway/v1',
    createSystemRouter({
      version: dependencies.version,
      commitSha: dependencies.commitSha,
      buildTime: dependencies.buildTime,
      readinessCheck: dependencies.readinessCheck,
    }),
  );

  if (dependencies.extraRouter) {
    app.use('/api/dashboard-gateway/v1', dependencies.extraRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

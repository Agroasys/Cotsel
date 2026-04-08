/**
 * SPDX-License-Identifier: Apache-2.0
 */
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { GatewayConfig } from './config/env';
import { createRequestContextMiddleware } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createSystemRouter, DependencyStatus } from './routes/system';

export interface GatewayAppDependencies {
  version: string;
  commitSha: string;
  buildTime: string;
  readinessCheck: () => Promise<DependencyStatus[]>;
  extraRouter?: Router;
}

function createCorsOptions(allowedOrigins: string[]) {
  if (allowedOrigins.length === 0) {
    return {};
  }

  const normalized = new Set(allowedOrigins.map((origin) => origin.replace(/\/$/, '')));

  return {
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = origin.replace(/\/$/, '');
      callback(
        normalized.has(normalizedOrigin)
          ? null
          : new Error('Origin is not allowed by GATEWAY_CORS_ALLOWED_ORIGINS'),
        normalized.has(normalizedOrigin),
      );
    },
  };
}

export function createApp(config: GatewayConfig, dependencies: GatewayAppDependencies) {
  const app = express();

  app.use(helmet());
  app.use(cors(createCorsOptions(config.corsAllowedOrigins)));
  app.use(createRequestContextMiddleware());
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request).rawBody = Buffer.from(buffer);
    },
  }));

  app.use('/api/dashboard-gateway/v1', createSystemRouter({
    version: dependencies.version,
    commitSha: dependencies.commitSha,
    buildTime: dependencies.buildTime,
    readinessCheck: dependencies.readinessCheck,
  }));

  if (dependencies.extraRouter) {
    app.use('/api/dashboard-gateway/v1', dependencies.extraRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

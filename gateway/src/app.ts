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

export function createApp(config: GatewayConfig, dependencies: GatewayAppDependencies) {
  const app = express();

  app.use(helmet());
  app.use(cors());
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

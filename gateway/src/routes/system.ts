/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { successResponse } from '../responses';

export interface DependencyStatus {
  name: string;
  status: 'ok' | 'degraded' | 'unavailable';
  detail?: string;
}

export interface SystemRouterOptions {
  version: string;
  commitSha: string;
  buildTime: string;
  readinessCheck: () => Promise<DependencyStatus[]>;
}

export function createSystemRouter(options: SystemRouterOptions): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json(successResponse({
      service: 'dashboard-gateway',
      status: 'ok',
    }));
  });

  router.get('/readyz', async (_req, res, next) => {
    try {
      const dependencies = await options.readinessCheck();
      const ready = dependencies.every((dependency) => dependency.status === 'ok');
      res.status(ready ? 200 : 503).json(successResponse({
        service: 'dashboard-gateway',
        ready,
        dependencies,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/version', (_req, res) => {
    res.status(200).json(successResponse({
      service: 'dashboard-gateway',
      version: options.version,
      commitSha: options.commitSha,
      buildTime: options.buildTime,
      sourceRepo: 'Agroasys.Web3layer',
    }));
  });

  return router;
}

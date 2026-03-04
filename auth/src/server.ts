/**
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { testConnection, closeConnection, pool } from './database/connection';
import { runMigrations } from './database/migrations';
import { createPostgresProfileStore } from './core/profileStore';
import { createPostgresSessionStore } from './core/sessionStore';
import { createSessionService } from './core/sessionService';
import { createInMemoryChallengeStore } from './core/challengeStore';
import { AuthController } from './api/controller';
import { createRouter } from './api/routes';
import { errorHandler } from './middleware/middleware';
import { Logger } from './utils/logger';

async function initializeDatabase(): Promise<void> {
  Logger.info('Initializing database...');
  await testConnection();
  await runMigrations();
  Logger.info('Database initialized');
}

async function gracefulShutdown(signal: string): Promise<void> {
  Logger.info(`${signal} received, shutting down gracefully...`);
  try {
    await closeConnection();
    Logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    Logger.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  await initializeDatabase();

  //  Stores & service 
  const profileStore = createPostgresProfileStore(pool);
  const sessionStore = createPostgresSessionStore(pool);
  const sessionService = createSessionService(sessionStore, profileStore);
  const challengeStore = createInMemoryChallengeStore();

  //  Express app 
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  const controller = new AuthController(sessionService, challengeStore);
  const router = createRouter(controller, sessionService);

  app.use('/api/auth/v1', router);
  app.use(errorHandler);

  //  Start 
  const server = app.listen(config.port, () => {
    Logger.info(`Auth service listening on port ${config.port}`);
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.on('error', (error) => {
    Logger.error('Server error', error);
    process.exit(1);
  });
}

bootstrap().catch((error) => {
  Logger.error('Failed to start auth service', error);
  process.exit(1);
});

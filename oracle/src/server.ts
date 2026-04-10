import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createCorsOptions, createHttpRateLimiter } from '@agroasys/shared-edge';
import { WebhookNotifier } from '@agroasys/notifications';
import { config } from './config';
import { createRouter } from './api/routes';
import { OracleController } from './api/controller';
import { errorHandler } from './middleware/middleware';
import { Logger } from './utils/logger';
import { testConnection, closeConnection } from './database/connection';
import { runMigrations } from './database/migrations';
import { TriggerManager } from './core/trigger-manager';
import { SDKClient } from './blockchain/sdk-client';
import { IndexerClient } from './blockchain/indexer-client';
import { ConfirmationWorker } from './worker/confirmation-worker';
import { oracleRateLimitPolicy } from './httpSecurity';

let confirmationWorker: ConfirmationWorker;
let indexerClient: IndexerClient;
let requestRateLimiterClose: (() => Promise<void>) | undefined;

async function initializeDatabase(): Promise<void> {
    Logger.info('Initializing database...');
    await testConnection();
    await runMigrations();
    Logger.info('Database initialized');
}

async function gracefulShutdown(signal: string): Promise<void> {
    Logger.info(`${signal} received, shutting down gracefully...`);
    
    try {
        if (confirmationWorker) {
            confirmationWorker.stop();
        }

        if (requestRateLimiterClose) {
            await requestRateLimiterClose();
        }
        
        if (indexerClient) {
            await indexerClient.close();
        }
        
        await closeConnection();
        
        Logger.info('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error('Error during graceful shutdown', error);
        process.exit(1);
    }
}

async function bootstrap() {
    try {
        await initializeDatabase();

        indexerClient = new IndexerClient(config.indexerGraphqlUrl);

        const notifier = new WebhookNotifier({
            enabled: config.notificationsEnabled,
            webhookUrl: config.notificationsWebhookUrl,
            cooldownMs: config.notificationsCooldownMs,
            requestTimeoutMs: config.notificationsRequestTimeoutMs,
            logger: Logger,
        });

        const sdkClient = new SDKClient(
            config.rpcUrl,
            config.rpcFallbackUrls,
            config.oraclePrivateKey,
            config.escrowAddress,
            config.usdcAddress,
            config.chainId,
            indexerClient
        );

        const triggerManager = new TriggerManager(
            sdkClient,
            config.retryAttempts,
            config.retryDelay,
            notifier,
            config.manualApprovalEnabled,
        );

        const controller = new OracleController(triggerManager);
        const requestRateLimiter = await createHttpRateLimiter({
            enabled: config.rateLimitEnabled,
            redisUrl: config.rateLimitRedisUrl,
            nodeEnv: config.nodeEnv,
            keyPrefix: 'oracle',
            classifyRoute: oracleRateLimitPolicy,
            logger: Logger,
        });
        requestRateLimiterClose = requestRateLimiter.close;

        const app = express();

        app.disable('x-powered-by');
        app.use(helmet());
        app.use(cors(createCorsOptions({
            allowedOrigins: config.corsAllowedOrigins,
            allowNoOrigin: config.corsAllowNoOrigin,
        })));
        app.use(express.json());

        app.use((req, res, next) => {
            Logger.info(`${req.method} ${req.path}`, {
                ip: req.ip,
                userAgent: req.headers['user-agent'],
            });
            next();
        });

        const router = createRouter(controller, testConnection);
        app.use('/api/oracle', requestRateLimiter.middleware, router);

        app.use(errorHandler);

        app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'NotFound',
                message: 'Route not found',
                timestamp: new Date().toISOString(),
            });
        });

        confirmationWorker = new ConfirmationWorker(indexerClient, sdkClient, notifier);
        confirmationWorker.start();

        app.listen(config.port, () => {
            Logger.info('Oracle service started', {
                port: config.port,
                environment: process.env.NODE_ENV || 'development',
                oracleAddress: config.escrowAddress,
                indexerGraphqlUrl: config.indexerGraphqlUrl,
            });
        });

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    } catch (error) {
        Logger.error('Failed to start server', error);
        process.exit(1);
    }
}

bootstrap();

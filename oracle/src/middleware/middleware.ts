import { Request, Response, NextFunction } from 'express';
import { failure } from '@agroasys/shared-http';
import { config } from '../config';
import { consumeHmacNonce } from '../database/queries';
import { Logger } from '../utils/logger';
import { ErrorResponse } from '../types';
import { deriveRequestNonce, verifyRequestSignature } from '../utils/crypto';


declare global {
    namespace Express {
        interface Request {
            apiKeyToken?: string;
            hmacSignature?: string;
            hmacNonce?: string;
        }
    }
}

function extractBearerToken(authHeader?: string): string | null {
    if (!authHeader) {
        return null;
    }

    if (!authHeader.startsWith('Bearer ')) {
        return null;
    }

    return authHeader.replace('Bearer ', '');
}

export function authMiddleware(req: Request, res: Response<ErrorResponse>, next: NextFunction): void {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
        Logger.warn('Missing authorization header', { ip: req.ip });
        res.status(401).json(failure('Unauthorized', 'Missing authorization header'));
        return;
    }

    if (token !== config.apiKey) {
        Logger.warn('Invalid API key', { ip: req.ip });
        res.status(401).json(failure('Unauthorized', 'Invalid API key'));
        return;
    }

    req.apiKeyToken = token;
    next();
}

export async function hmacMiddleware(req: Request, res: Response<ErrorResponse>, next: NextFunction): Promise<void> {
    const timestamp = req.headers['x-timestamp'] as string;
    const signature = req.headers['x-signature'] as string;
    const providedNonce = (req.headers['x-nonce'] as string | undefined)?.trim();
    const apiKeyToken = req.apiKeyToken || extractBearerToken(req.headers.authorization) || 'oracle-service';

    if (!timestamp || !signature) {
        Logger.warn('Missing HMAC headers', { ip: req.ip });
        res.status(401).json(failure('Unauthorized', 'Missing X-Timestamp or X-Signature headers'));
        return;
    }

    try {
        const body = JSON.stringify(req.body);
        verifyRequestSignature(timestamp, body, signature, config.hmacSecret);
        const nonce = providedNonce || deriveRequestNonce(timestamp, body, signature);

        if (!nonce || nonce.length > 255) {
            Logger.warn('Invalid nonce format', { ip: req.ip });
            res.status(401).json(failure('Unauthorized', 'Invalid X-Nonce header'));
            return;
        }

        const nonceAccepted = await consumeHmacNonce(apiKeyToken, nonce, config.hmacNonceTtlSeconds);
        if (!nonceAccepted) {
            Logger.warn('Replay detected for nonce', {
                ip: req.ip,
                nonce: nonce.substring(0, 16) + '...',
            });
            res.status(401).json(failure('Unauthorized', 'Replay detected for nonce'));
            return;
        }
        
        req.hmacSignature = signature;
        req.hmacNonce = nonce;
        
        Logger.info('HMAC signature verified', { 
            timestamp,
            ip: req.ip,
            nonce: nonce.substring(0, 16) + '...',
            signature: signature.substring(0, 16) + '...'
        });
        
        next();
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTimestampOrSignatureError =
            errorMessage.includes('Request timestamp') ||
            errorMessage.includes('Invalid HMAC signature');

        if (!isTimestampOrSignatureError) {
            Logger.error('HMAC nonce persistence failed', {
                error: errorMessage,
                ip: req.ip,
            });
            res.status(503).json(failure('ServiceUnavailable', 'Authentication nonce store unavailable'));
            return;
        }

        Logger.warn('HMAC verification failed', { 
            error: errorMessage,
            ip: req.ip 
        });
        res.status(401).json(failure('Unauthorized', errorMessage));
    }
}

export function errorHandler(err: any, req: Request, res: Response<ErrorResponse>, next: NextFunction): void {
    Logger.error('Unhandled error', err);

    res.status(500).json(failure('InternalServerError', err.message || 'An unexpected error occurred'));
}

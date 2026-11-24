/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cotsel#946: a trusted session exchange carries the operator's authentication
 * assurance. The fixture is agroasys-backend's canonical signed request
 * (src/contracts/fixtures/cotsel-session-exchange.v1.json, agroasys-backend#797),
 * copied byte for byte to docs/api/fixtures.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { HttpError } from '@agroasys/shared-http';
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  signServiceAuthCanonicalString,
} from '@agroasys/shared-auth/serviceAuth';
import {
  AUTH_TIME_MAX_FUTURE_SKEW_SECONDS,
  parseAuthenticationAssurance,
  SessionController,
} from '../src/api/sessionController';
import type { SessionService } from '../src/core/sessionService';
import type { AuthenticationAssurance } from '../src/types';
import { ANY_ROLE_AUTHORITY } from './helpers/exchangeAuthority';

interface ExchangeFixture {
  request: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    rawBody: string;
  };
  verification: { secret: string; bodySha256: string; canonical: string };
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../docs/api/fixtures/cotsel-session-exchange.v1.json'),
    'utf8',
  ),
) as ExchangeFixture;
const FIXTURE_NOW = Number(fixture.request.headers['X-Timestamp']);

describe('authentication assurance in a trusted session exchange', () => {
  describe('parseAuthenticationAssurance', () => {
    const now = 1_800_000_000;

    it('leaves a session without assurance when no claims are sent', () => {
      expect(parseAuthenticationAssurance({}, now)).toEqual({
        authTime: null,
        method: null,
        strength: null,
      });
    });

    it('accepts valid claims, including an authTime slightly ahead of our clock', () => {
      expect(
        parseAuthenticationAssurance(
          {
            authTime: now + AUTH_TIME_MAX_FUTURE_SKEW_SECONDS,
            authMethod: 'webauthn',
            authStrength: 'hardware_webauthn',
          },
          now,
        ),
      ).toEqual({
        authTime: now + AUTH_TIME_MAX_FUTURE_SKEW_SECONDS,
        method: 'webauthn',
        strength: 'hardware_webauthn',
      });
    });

    it.each([
      [{ authTime: '1800000000' }, /authTime/],
      [{ authTime: 1.5 }, /authTime/],
      [{ authTime: 0 }, /authTime/],
      [{ authTime: -1 }, /authTime/],
      [{ authTime: now + AUTH_TIME_MAX_FUTURE_SKEW_SECONDS + 1 }, /in the future/],
      [{ authMethod: 'sms' }, /authMethod/],
      [{ authStrength: 'strong' }, /authStrength/],
      [{ authStrength: null }, /authStrength/],
    ])('rejects invalid claims %p rather than dropping them', (body, message) => {
      expect(() => parseAuthenticationAssurance(body, now)).toThrow(HttpError);
      expect(() => parseAuthenticationAssurance(body, now)).toThrow(message);
    });
  });

  describe('agroasys-backend contract fixture cotsel-session-exchange.v1', () => {
    it('matches the shared service-auth canonical string and signature', () => {
      const bodySha256 = crypto
        .createHash('sha256')
        .update(fixture.request.rawBody, 'utf8')
        .digest('hex');
      expect(bodySha256).toBe(fixture.verification.bodySha256);
      const canonical = buildServiceAuthCanonicalString({
        method: fixture.request.method,
        path: fixture.request.path,
        query: fixture.request.query,
        bodySha256,
        timestamp: fixture.request.headers['X-Timestamp'],
        nonce: fixture.request.headers['X-Nonce'],
      });
      expect(canonical).toBe(fixture.verification.canonical);
      expect(signServiceAuthCanonicalString(fixture.verification.secret, canonical)).toBe(
        fixture.request.headers['X-Signature'],
      );
    });

    it('is verified by the service-auth middleware and stored with its assurance', async () => {
      const issued: Array<{ identity: unknown; authentication?: AuthenticationAssurance }> = [];
      const sessionService = {
        issueTrustedSession: jest.fn(async (identity, _authority, _ttl, authentication) => {
          issued.push({ identity, authentication });
          return { sessionId: 'session-token', expiresAt: FIXTURE_NOW + 3600 };
        }),
      } as unknown as SessionService;
      const controller = new SessionController(
        sessionService,
        3600,
        () => ANY_ROLE_AUTHORITY,
        () => FIXTURE_NOW,
      );
      const verify = createServiceAuthMiddleware({
        enabled: true,
        maxSkewSeconds: 300,
        nonceTtlSeconds: 600,
        nowSeconds: () => FIXTURE_NOW,
        lookupApiKey: (apiKey) =>
          apiKey === fixture.request.headers['X-Api-Key']
            ? { id: apiKey, secret: fixture.verification.secret, active: true }
            : undefined,
        consumeNonce: async () => true,
      });

      // The request exactly as express hands it to the middleware: the raw bytes
      // the signature covers, and the parsed body the controller reads.
      async function exchange(rawBody: string) {
        const headers = new Map(
          Object.entries(fixture.request.headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        );
        const req = {
          method: fixture.request.method,
          originalUrl: fixture.request.path,
          header: (name: string) => headers.get(name.toLowerCase()),
          rawBody: Buffer.from(rawBody, 'utf8'),
          body: JSON.parse(rawBody),
        } as unknown as Parameters<SessionController['exchangeTrustedSession']>[0];
        const res = {
          statusCode: 200,
          status(code: number) {
            this.statusCode = code;
            return this;
          },
          json() {
            return this;
          },
        };
        const response = res as unknown as Parameters<
          SessionController['exchangeTrustedSession']
        >[1];
        let passed = false;
        await verify(req, response, () => {
          passed = true;
        });
        if (passed) {
          await controller.exchangeTrustedSession(req, response);
        }
        return { passed, status: res.statusCode };
      }

      expect(await exchange(fixture.request.rawBody)).toEqual({ passed: true, status: 201 });
      expect(
        await exchange(
          fixture.request.rawBody.replace('"authTime":1769996400', '"authTime":1769996409'),
        ),
      ).toEqual({ passed: false, status: 401 });

      expect(issued).toHaveLength(1);
      expect(issued[0].authentication).toEqual({
        authTime: 1769996400,
        method: 'webauthn',
        strength: 'hardware_webauthn',
      });
      expect(issued[0].identity).toMatchObject({
        accountId: 'agroasys-user:42',
        role: 'admin',
        walletAddress: '0x00000000000000000000000000000000000000a1',
      });
    });
  });
});

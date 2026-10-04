import { HttpError } from '@agroasys/shared-http';
import type { Request } from 'express';
import { TENANT_ID_PATTERN } from '../types';

/**
 * A Ricardian tenant is only as strong as the identity it is bound to. Taking it from the
 * request let any authenticated service name another tenant and read its complete terms.
 *
 * The tenant therefore starts from the verified service-auth principal. Platform traffic
 * reaches Ricardian through the gateway, which authenticates the platform and then calls
 * under its own service key, so a named tenant can be a delegation the caller is entitled
 * to make. A caller on the delegation allowlist may name the tenant it authenticated, inside
 * its HMAC-signed request. Any other caller is bound to its own principal.
 */

export interface RicardianAuthPrincipal {
  apiKeyId: string;
}

export type TenantAuthenticatedRequest = Request & { serviceAuth?: RicardianAuthPrincipal };

export interface TenantResolutionOptions {
  /**
   * Mirrors `config.authEnabled`. With auth off there is no principal to derive from, so a
   * local caller must name the tenant; production rejects that configuration at startup.
   */
  authEnabled: boolean;
  /** API key ids permitted to act for a tenant they authenticated. */
  delegationApiKeyIds: readonly string[];
}

function parseClaimedTenant(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value.trim())) {
    throw new HttpError(400, 'ValidationError', 'Invalid tenantId format');
  }

  return value.trim();
}

export function resolveTenant(
  req: TenantAuthenticatedRequest,
  claimedTenant: unknown,
  options: TenantResolutionOptions,
): string {
  const claimed = parseClaimedTenant(claimedTenant);

  if (!options.authEnabled) {
    if (!claimed) {
      throw new HttpError(
        400,
        'ValidationError',
        'tenantId is required while service authentication is disabled',
      );
    }

    return claimed;
  }

  const principal = req.serviceAuth;
  if (!principal?.apiKeyId) {
    throw new HttpError(
      401,
      'TenantUnauthenticated',
      'Ricardian tenant scope requires an authenticated principal',
    );
  }

  if (!claimed || claimed === principal.apiKeyId) {
    return principal.apiKeyId;
  }

  // Refused before any lookup, so the response never depends on whether the document exists.
  if (!options.delegationApiKeyIds.includes(principal.apiKeyId)) {
    throw new HttpError(
      403,
      'TenantMismatch',
      'tenantId does not match the authenticated principal',
    );
  }

  return claimed;
}

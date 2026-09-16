/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { parseServiceApiKeys, type ServiceApiKey } from '@agroasys/shared-auth/serviceAuth';

export function createAdminControlApiKeyLookup(
  rawKeys: string,
  allowedApiKeyIds: string[],
): (apiKey: string) => ServiceApiKey | undefined {
  const keys = parseServiceApiKeys(rawKeys);
  const keysById = new Map<string, ServiceApiKey>();

  for (const key of keys) {
    if (keysById.has(key.id)) {
      throw new Error(`AUTH_ADMIN_CONTROL_API_KEYS_JSON contains duplicate key ID ${key.id}`);
    }
    keysById.set(key.id, key);
  }

  const allowed = new Set(allowedApiKeyIds);
  const allowedKeys = [...allowed].map((id) => {
    const key = keysById.get(id);
    if (!key) {
      throw new Error(`Allowed admin-control API key ${id} is not configured`);
    }
    if (!key.humanPrincipalId) {
      throw new Error(`Admin-control API key ${id} requires humanPrincipalId`);
    }
    return key;
  });

  const activeHumanPrincipals = new Set(
    allowedKeys.filter((key) => key.active).map((key) => key.humanPrincipalId),
  );
  if (activeHumanPrincipals.size < 2) {
    throw new Error(
      'Admin control requires at least two distinct active human principals for signer activation',
    );
  }

  return (apiKey: string) => {
    const key = keysById.get(apiKey);
    return key && allowed.has(key.id) ? key : undefined;
  };
}

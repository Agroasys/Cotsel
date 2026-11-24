/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The operator assurance Agroasys attaches to a break-glass grant (Cotsel#946):
 * a hardware WebAuthn step-up `ageSeconds` ago.
 */
export function freshOperatorAuthentication(ageSeconds = 0) {
  return {
    authTime: Math.floor(Date.now() / 1000) - ageSeconds,
    authMethod: 'webauthn',
    authStrength: 'hardware_webauthn',
  };
}

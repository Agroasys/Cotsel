/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SessionAuthentication } from '../../src/core/authSessionClient';

/**
 * Authentication assurance for a session whose operator completed a hardware
 * WebAuthn step-up just now, so privileged mutations pass requireRecentStepUp.
 */
export function freshStepUp(ageSeconds = 0): SessionAuthentication {
  return {
    authTime: Math.floor(Date.now() / 1000) - ageSeconds,
    method: 'webauthn',
    strength: 'hardware_webauthn',
  };
}

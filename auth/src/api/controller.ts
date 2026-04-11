/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { LegacyWalletAuthController } from './legacyWalletAuthController';
import { SessionController } from './sessionController';
import { ChallengeStore } from '../core/challengeStore';
import { SessionService } from '../core/sessionService';

export { buildChallengeMessage } from './legacyWalletAuthController';
export { LegacyWalletAuthController } from './legacyWalletAuthController';
export { SessionController } from './sessionController';

/**
 * Compatibility facade for tests and older internal imports.
 * New runtime wiring should prefer the split controllers directly.
 */
export class AuthController {
  private readonly legacyWallet: LegacyWalletAuthController;
  private readonly session: SessionController;

  constructor(
    sessionService: SessionService,
    challengeStore: ChallengeStore,
    maxSessionTtlSeconds: number = 86400,
  ) {
    this.legacyWallet = new LegacyWalletAuthController(
      sessionService,
      challengeStore,
      maxSessionTtlSeconds,
    );
    this.session = new SessionController(sessionService, maxSessionTtlSeconds);
  }

  getChallenge(...args: Parameters<LegacyWalletAuthController['getChallenge']>) {
    return this.legacyWallet.getChallenge(...args);
  }

  login(...args: Parameters<LegacyWalletAuthController['login']>) {
    return this.legacyWallet.login(...args);
  }

  exchangeTrustedSession(...args: Parameters<SessionController['exchangeTrustedSession']>) {
    return this.session.exchangeTrustedSession(...args);
  }

  refresh(...args: Parameters<SessionController['refresh']>) {
    return this.session.refresh(...args);
  }

  revoke(...args: Parameters<SessionController['revoke']>) {
    return this.session.revoke(...args);
  }

  getSession(...args: Parameters<SessionController['getSession']>) {
    return this.session.getSession(...args);
  }
}

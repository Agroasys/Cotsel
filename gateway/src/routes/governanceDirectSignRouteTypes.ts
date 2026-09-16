/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayConfig } from '../config/env';
import type { AuthSessionClient } from '../core/authSessionClient';
import type { GovernanceMutationService } from '../core/governanceMutationService';
import type { GovernanceMutationPreflightReader } from '../core/governanceStatusService';

export interface GovernanceDirectSignRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceReader: GovernanceMutationPreflightReader;
  mutationService: GovernanceMutationService;
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayConfig } from '../config/env';
import type { GovernanceMutationService } from '../core/governanceMutationService';
import type { GovernanceMutationPreflightReader } from '../core/governanceStatusService';

export interface GovernanceDirectSignRouterOptions {
  config: GatewayConfig;
  governanceReader: GovernanceMutationPreflightReader;
  mutationService: GovernanceMutationService;
}

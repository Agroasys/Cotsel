/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayConfig } from '../config/env';
import type { FreezeReviewStore } from '../core/freezeReviewStore';
import type { ContainmentEvidenceService } from '../core/containmentEvidence';
import type { AuthSessionClient } from '../core/authSessionClient';
import type { GovernanceMutationService } from '../core/governanceMutationService';
import type { GovernanceMutationPreflightReader } from '../core/governanceStatusService';

export interface GovernanceDirectSignRouterOptions {
  freezeReviewStore?: FreezeReviewStore;
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceReader: GovernanceMutationPreflightReader;
  mutationService: GovernanceMutationService;
  /**
   * Verifies a contained trade's signed reconciliation evidence before a
   * trade-scoped unpause is approved (Cotsel#951). Absent means fail closed.
   */
  containmentEvidence?: ContainmentEvidenceService;
}

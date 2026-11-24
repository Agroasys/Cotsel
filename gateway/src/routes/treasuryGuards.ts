/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guard chains for treasury mutations: write access, the capability for the
 * step, and a recent upstream step-up (Cotsel#946).
 */
import type { RequestHandler } from 'express';
import type { GatewayConfig } from '../config/env';
import type { AuditLogStore } from '../core/auditLogStore';
import { requireMutationWriteAccess, requireTreasuryCapability } from '../middleware/auth';
import { requireRecentStepUp } from '../middleware/stepUp';

export interface TreasuryWriteGuards {
  requireTreasuryPrepare: RequestHandler[];
  requireTreasuryApprove: RequestHandler[];
  requireTreasuryExecuteMatch: RequestHandler[];
  requireTreasuryClose: RequestHandler[];
}

export function createTreasuryWriteGuards(
  config: GatewayConfig,
  auditLogStore?: AuditLogStore,
): TreasuryWriteGuards {
  const requireWrite = requireMutationWriteAccess();
  const requireStepUp = requireRecentStepUp(config, { auditLogStore }) as RequestHandler;
  const chain = (capability: Parameters<typeof requireTreasuryCapability>[0]) => [
    requireWrite,
    requireTreasuryCapability(capability),
    requireStepUp,
  ];
  return {
    requireTreasuryPrepare: chain('treasury:prepare'),
    requireTreasuryApprove: chain('treasury:approve'),
    requireTreasuryExecuteMatch: chain('treasury:execute_match'),
    requireTreasuryClose: chain('treasury:close'),
  };
}

/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AuthServiceRole, OperatorCapability } from './authSessionClient';
import type { GatewayConfig } from '../config/env';
import { type GatewayPrincipal, type GatewayRole, matchesAllowlist } from '../middleware/auth';

export interface OperatorRouteCapabilities {
  overviewRead: boolean;
  operationsRead: boolean;
  tradesRead: boolean;
  governanceRead: boolean;
  complianceRead: boolean;
}

export interface OperatorActionCapabilities {
  governanceWrite: boolean;
  complianceWrite: boolean;
  treasuryRead: boolean;
  treasuryPrepare: boolean;
  treasuryApprove: boolean;
  treasuryExecuteMatch: boolean;
  treasuryClose: boolean;
}

export interface OperatorWriteAccess {
  mutationsConfigured: boolean;
  allowlisted: boolean;
  effective: boolean;
}

export interface OperatorCapabilitySubject {
  accountId: string;
  userId: string;
  walletAddress: string | null;
  authRole: AuthServiceRole;
  gatewayRoles: GatewayRole[];
  capabilities: OperatorCapability[];
}

export interface OperatorCapabilitySnapshot {
  subject: OperatorCapabilitySubject;
  routes: OperatorRouteCapabilities;
  actions: OperatorActionCapabilities;
  writeAccess: OperatorWriteAccess;
}

export function buildOperatorCapabilitySnapshot(
  principal: GatewayPrincipal,
  config: GatewayConfig,
): OperatorCapabilitySnapshot {
  const canReadOperatorRoutes = principal.gatewayRoles.includes('operator:read');
  const allowlisted = matchesAllowlist(principal.session, config.writeAllowlist);
  const canWriteOperatorActions =
    principal.gatewayRoles.includes('operator:write') && config.enableMutations && allowlisted;

  return {
    subject: {
      accountId: principal.session.accountId ?? principal.session.userId,
      userId: principal.session.userId,
      walletAddress: principal.session.walletAddress,
      authRole: principal.session.role,
      gatewayRoles: principal.gatewayRoles,
      capabilities: principal.session.capabilities ?? [],
    },
    routes: {
      overviewRead: canReadOperatorRoutes,
      operationsRead: canReadOperatorRoutes,
      tradesRead: canReadOperatorRoutes,
      governanceRead: canReadOperatorRoutes,
      complianceRead: canReadOperatorRoutes,
    },
    actions: {
      governanceWrite:
        canWriteOperatorActions &&
        principal.operatorActionCapabilities.includes('governance:write'),
      complianceWrite:
        canWriteOperatorActions &&
        principal.operatorActionCapabilities.includes('compliance:write'),
      treasuryRead: principal.treasuryCapabilities.includes('treasury:read'),
      treasuryPrepare:
        canWriteOperatorActions && principal.treasuryCapabilities.includes('treasury:prepare'),
      treasuryApprove:
        canWriteOperatorActions && principal.treasuryCapabilities.includes('treasury:approve'),
      treasuryExecuteMatch:
        canWriteOperatorActions &&
        principal.treasuryCapabilities.includes('treasury:execute_match'),
      treasuryClose:
        canWriteOperatorActions && principal.treasuryCapabilities.includes('treasury:close'),
    },
    writeAccess: {
      mutationsConfigured: config.enableMutations,
      allowlisted,
      effective: canWriteOperatorActions,
    },
  };
}
